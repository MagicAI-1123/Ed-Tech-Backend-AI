import { ai, PORT, server, embedding, pineconeIndex } from './src/routes/index';
import { Server } from 'socket.io';
import { PineconeStore } from 'langchain/vectorstores/pinecone';
import { PromptTemplate } from 'langchain/prompts';
import { BufferMemory, ChatMessageHistory } from 'langchain/memory';
import ChatLog, { createNewChat } from './db/models/conversationLog';
import {
  HumanChatMessage,
  AIChatMessage,
  SystemChatMessage
} from 'langchain/schema';
import { summarizeNotePrompt } from './src/helpers/promptTemplates/index';
import {
  ConversationChain,
  ConversationalRetrievalQAChain,
  RetrievalQAChain
} from 'langchain/chains';
import { ChatOpenAI } from 'langchain/chat_models/openai';
import { updateDocument } from './db/models/document';
import {
  getChatConversationId,
  createNewConversation
} from './db/models/conversation';
import { getChatLogs } from './db/models/conversationLog';
import config from 'config';
import paginatedFind from './src/helpers/pagination';

// Setting up some general shit for global AI assistant usage
const wrapForQL = (role: 'user' | 'assistant', content: string) => ({
  role,
  content
});
const { apikey, model: modelName } = config.get('openai') as any;
const TOP_K = 15;

const getDocumentVectorStore = async ({
  studentId,
  documentId
}: {
  studentId: string;
  documentId: string;
}) => {
  return await PineconeStore.fromExistingIndex(embedding, {
    pineconeIndex,
    namespace: studentId,
    filter: { documentId: { $eq: `${documentId}` } }
  });
};

const socketAiModel = (socket: any, event: string) => {
  return new ChatOpenAI({
    openAIApiKey: apikey,
    modelName,
    streaming: true,
    callbacks: [
      {
        handleLLMNewToken(token) {
          socket.emit(`${event} start`, token);
        }
      }
    ]
  });
};

ai.listen(PORT, () =>
  console.log(
    `\n🤖🤖🤖 All your base are belong to me. Eavesdropping on 0.0.0.0:${PORT}\n`
  )
);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.use(async (socket, next) => {
  try {
    const { studentId } = socket.handshake.auth;

    if (!studentId) {
      next(new Error('studentId  required'));
    } else {
      next();
    }
  } catch (e) {
    next(new Error('Someting went wrong'));
  }
});

const docChatNamespace = io.of('/doc-chat');

const homeworkHelpNamespace = io.of('/homework-help');

docChatNamespace.on('connection', async (socket) => {
  const { studentId, documentId } = socket.handshake.auth;

  const conversationId = await getChatConversationId({
    referenceId: documentId,
    reference: 'document'
  });

  const vectorStore = await getDocumentVectorStore({ studentId, documentId });

  const docChatChain = (event: string, topK: number) => {
    const model = socketAiModel(socket, event);

    const llm = new ChatOpenAI({
      openAIApiKey: apikey
    });

    const chain = ConversationalRetrievalQAChain.fromLLM(
      model,
      vectorStore.asRetriever(topK),
      {
        memory: new BufferMemory({
          memoryKey: 'chat_history',
          inputKey: 'question',
          outputKey: 'text'
        }),
        questionGeneratorChainOptions: {
          llm
        }
      }
    );

    return chain;
  };

  // Done with setting up the chat AI requirements, so we can tell the client we're ready to discuss.
  socket.emit('ready', true);

  // Client sends us a chat message
  socket.on('chat message', async (message) => {
    const userQuery = wrapForQL('user', message);
    const event = 'chat response';

    let topK = 30;

    let chain = docChatChain(event, topK);

    const question = `Using only context from the PDF document supplied, answer any questions the user asks — never make one up outside of the information provided. Make your answers brief, exciting and informative. Be charming and have a personality.
    
    Suggest follow-up discussions based on the information, and format them in bullet points of three discussions.
    
    Make your answers in markdown.

    Do not discuss with me. If I send you a message that does not seem like  a question about the document, respond with a variation of: 'I'm sorry, that is not a question about this document. Would you like to ask me something about this document?'
    
    My question is: ${message}
    
    Your answer:`;

    const callChain = async () =>
      await chain
        .call({ question })
        .then(async (response) => {
          socket.emit(`${event} end`, response?.text);
          const assistantResponse = wrapForQL('assistant', response?.text);

          Promise.all([
            await createNewChat({
              studentId,
              log: userQuery,
              conversationId
            }),
            await createNewChat({
              studentId,
              log: assistantResponse,
              conversationId
            })
          ]);
        })
        .catch(async (e: any): Promise<any> => {
          if (e?.response?.data?.error?.code === 'context_length_exceeded') {
            topK -= 5;
            console.log('Error, context length: ', topK);
            chain = docChatChain(event, topK);
            return await callChain();
          }

          console.log(e.message, e?.response?.data?.error?.code);
          socket.emit(
            `${event} start`,
            'I ran into some trouble coming up with an answer. Can you ask me the question again?'
          );
        });

    await callChain(); //NB: this part is also emitting a message to the client!
  });

  socket.on('generate summary', async () => {
    const model = socketAiModel(socket, 'summary');
    const chain = RetrievalQAChain.fromLLM(
      model,
      vectorStore.asRetriever(TOP_K)
    );

    const answer = await chain.call({ query: summarizeNotePrompt });
    await updateDocument({
      data: {
        summary: answer?.text
      },
      referenceId: studentId,
      documentId
    });
  });
});

// Homework help namespace
homeworkHelpNamespace.on('connection', async (socket) => {
  const { studentId, topic, conversationId: convoId } = socket.handshake.auth;
  const event = 'chat response';

  const systemPrompt = `Let's play a game. You're going to play the role of a tutor named Socrates, and I'm going to play the role of a student trying to pass their homework. I'm going to give you a topic, and we will discuss the topic, with you guiding me towards understanding.

Your ideal approach is one where you tease out my knowledge and weak areas and explain the topic piece by piece, while asking me questions to see if I understand the subject. Prefer conciseness over a wall of text. 

Here are your rules:
1. Your tone is friendly, helpful and guiding towards understanding.
2. Your messages end in a question crafted to both gauge my understanding and move the lessons further.
3. You're immensely observant, and must be aware of when you're starting to lose me, and steer the conversation towards better understanding. 
4. You must never refer to our interaction as a game.
5. You must never break character. 
6. You must never directly or indirectly call attention to the fact that your character is called Socrates.

My homework is ${topic}.

Our current conversation so far: {history}

Human: {input}
Socrates:`;

  let conversationId = convoId;
  let isNewChat;

  if (!convoId) {
    conversationId = await createNewConversation({
      referenceId: studentId,
      reference: 'student'
    }).then((convo) => convo?.id);
    isNewChat = true;
  }
  const chats = await paginatedFind(
    ChatLog,
    {
      studentId,
      conversationId
    },
    { limit: 10 }
  );

  const lastTenChats = chats.map((chat: any) => chat.log).reverse();

  const pastMessages: any[] = [];

  lastTenChats.forEach((message: any) => {
    if (message.role === 'assistant')
      pastMessages.push(new AIChatMessage(message.content));
    if (message.role === 'user')
      pastMessages.push(new HumanChatMessage(message.content));
  });

  const model = socketAiModel(socket, event);

  if (!isNewChat) {
    // Here I assume lastTenChats contains the chat logs in the order they were sent.
    const lastChat = lastTenChats[lastTenChats.reverse().length - 1];

    // Only emit the ready message if the last message was not from the AI.
    if (lastChat.role !== 'assistant') {
      socket.emit('ready', true);
    }
  } else {
    socket.emit('ready', true);
  }

  const memory = new BufferMemory({
    chatHistory: new ChatMessageHistory(pastMessages)
  });

  const prompt = new PromptTemplate({
    template: systemPrompt,
    inputVariables: ['history', 'input']
  });

  const chain = new ConversationChain({
    llm: model,
    memory,
    prompt
  });

  socket.on('chat message', async (message) => {
    const answer = await chain.call({ input: message });
    socket.emit(`${event} end`, answer?.response);

    const userQuery = wrapForQL('user', message);
    const assistantResponse = wrapForQL('assistant', answer?.response);

    pastMessages.push(new HumanChatMessage(message));
    pastMessages.push(new AIChatMessage(answer?.response));

    Promise.all([
      await createNewChat({
        studentId,
        log: userQuery,
        conversationId
      }),
      await createNewChat({
        studentId,
        log: assistantResponse,
        conversationId
      })
    ]);
  });
});
