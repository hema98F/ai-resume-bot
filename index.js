require("dotenv").config();
console.log("JWT_SECRET:", process.env.JWT_SECRET);
console.log("OPENROUTER:", process.env.OPENROUTER_API_KEY);
console.log("MONGO:", process.env.MONGODB_URI);
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const pdf = require("pdf-parse");
console.log(typeof pdf);
const fetch = require("node-fetch");
const cors = require("cors");
const Chunk = require("./models/Chunk");
const { fromBuffer } = require("pdf2pic");
const jwt = require("jsonwebtoken");

console.log("API KEY:", process.env.OPENROUTER_API_KEY ? "EXISTS" : "MISSING");
console.log("MONGO URI:", process.env.MONGODB_URI ? "EXISTS" : "MISSING");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const corsOptions = {
  origin: ["http://localhost:4200", "https://ai-chat-ui-blue.vercel.app"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
};

app.use(cors(corsOptions));

// Connect to MongoDB Atlas
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB Atlas connected!"))
  .catch((err) => console.error("MongoDB error:", err));

// Multer — store PDF in memory, not disk
const upload = multer({ storage: multer.memoryStorage() });

// ─── HELPER: Get embedding for any text
async function getEmbedding(text) {
  console.log("Calling embedding API...");
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // model: "openai/text-embedding-ada-002",
      model: "openai/text-embedding-ada-002",
      input: text,
    }),
  });

  const data = await response.json();
  console.log(
    "Embedding API response:",
    JSON.stringify(data).substring(0, 100),
  );

  // Guard against unexpected response
  if (!data.data || !data.data[0]) {
    console.error("Unexpected embedding response:", JSON.stringify(data));
    throw new Error(`Embedding API error: ${JSON.stringify(data)}`);
  }

  return data.data[0].embedding;
}

// HELPER: Split text into chunks
function splitIntoChunks(text, chunkSize = 200) {
  const words = text.split(" ");
  const chunks = [];
  let current = [];

  for (const word of words) {
    current.push(word);
    if (current.length >= chunkSize) {
      chunks.push(current.join(" "));
      current = [];
    }
  }

  if (current.length > 0) {
    chunks.push(current.join(" "));
  }

  return chunks;
}

// ─── MIDDLEWARE: Verify JWT

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized - please login" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    req.userName = decoded.name;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ROUTE 1: Upload PDF
app.post("/upload", authMiddleware, upload.single("pdf"), async (req, res) => {
  try {
    console.log("PDF received, extracting text...");

    const filename = req.file.originalname;

    // Step 1 — extract text directly
    const pdfData = await pdf(req.file.buffer);
    let fullText = pdfData.text;

    // Clean text
    fullText = fullText
      .replace(/([a-z])([A-Z])/g, "$1 $2") // fix merged words
      .replace(/\s+/g, " ") // normalize spaces
      .replace(/\n+/g, "\n") // normalize newlines
      .trim();

    console.log("Extracted:", fullText.length);

    // Step 2 — chunk
    const chunks = splitIntoChunks(fullText, 100);

    // Step 3 — clear old data
    await Chunk.deleteMany({ userId: req.userId });

    // Step 4 — embed
    const embeddings = await Promise.all(
      chunks.map((chunk) => getEmbedding(chunk)),
    );

    // Step 5 — save
    await Promise.all(
      embeddings.map((embedding, i) =>
        Chunk.create({
          text: chunks[i],
          embedding,
          source: filename,
          chunkIndex: i,
          userId: req.userId,
        }),
      ),
    );

    console.log("All chunks saved");

    res.json({
      message: "PDF processed successfully!",
      filename,
      totalChunks: chunks.length,
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ─── ROUTE 2: Ask a question
app.post("/ask", authMiddleware, async (req, res) => {

   console.log("ASK BODY:", req.body);
  // const { question } = req.body;
  if (!req.body || !req.body.question) {
    return res.status(400).json({ error: "Question is required" });
  }

  const { question } = req.body;

  if (!question)
    return res.status(400).json({ error: "Please send a question" });

  try {
    const questionEmbedding = await getEmbedding(question);

    console.log("userId for search:", req.userId);
    console.log("embedding length:", questionEmbedding.length);
    const countCheck = await Chunk.countDocuments({ userId: req.userId });
    console.log("chunks in DB for this user:", countCheck);
    const relevantChunks = await Chunk.aggregate([
      {
        $vectorSearch: {
          index: "vector_index",
          path: "embedding",
          queryVector: questionEmbedding,
          numCandidates: 50,
          limit: 5,
          filter: { userId: { $eq: req.userId } },
        },
      },
      {
        $project: { text: 1, source: 1, score: { $meta: "vectorSearchScore" } },
      },
    ]);

    if (relevantChunks.length === 0) {
      return res.json({
        answer:
          "No relevant information found. Please upload your resume first.",
      });
    }

    const context = relevantChunks.map((c) => c.text).join("\n\n");

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-3.5-turbo",
          messages: [
            {
              role: "user",
              content: `You are a resume assistant. Answer the question using ONLY the context below.
The context is extracted from a resume — answer any question about the person's background.

CONTEXT:
${context}

QUESTION: ${question}

Be concise and direct.`,
            },
          ],
        }),
      },
    );

    const data = await response.json();
    res.json({
      question,
      answer: data.choices[0].message.content,
      sources: relevantChunks.map((c) => ({
        source: c.source,
        score: c.score?.toFixed(3),
        preview: c.text.substring(0, 100) + "...",
      })),
    });
  } catch (error) {
    console.error("Ask error:", error);
    res.status(500).json({ error: error.message });
  }
});
// app.post("/ask", authMiddleware, async (req, res) => {
//   const { question } = req.body;

//   if (!question) {
//     return res.status(400).json({ error: "Please send a question" });
//   }

//   // STEP 1: ROUTER
//   const routerResponse = await fetch(
//     "https://openrouter.ai/api/v1/chat/completions",
//     {
//       method: "POST",
//       headers: {
//         Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify({
//         model: "openai/gpt-3.5-turbo",
//         messages: [
//           {
//             role: "user",
//             content: `
// Classify this question into ONE of these:
// - profile (name, skills, education, contact, projects)
// - rag (summary, explanation, experience)

// Return ONLY one word.

// Question: ${question}
//         `,
//           },
//         ],
//       }),
//     },
//   );

//   const routerData = await routerResponse.json();
//   const route = routerData.choices[0].message.content.trim();

//   // STEP 2: HANDLE PROFILE QUESTIONS
//   if (route === "profile") {
//     // const chunks = await Chunk.find({ userId: req.userId });
//     // Get only the most recently uploaded file for this user
//     const latestChunk = await Chunk.findOne({ userId: req.userId }).sort({
//       createdAt: -1,
//     });
//     const chunks = latestChunk
//       ? await Chunk.find({ userId: req.userId, source: latestChunk.source })
//       : [];

//     const fullText = chunks.map((c) => c.text).join("\n");

//     const response = await fetch(
//       "https://openrouter.ai/api/v1/chat/completions",
//       {
//         method: "POST",
//         headers: {
//           Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
//           "Content-Type": "application/json",
//         },
//         body: JSON.stringify({
//           model: "openai/gpt-3.5-turbo",
//           messages: [
//             {
//               role: "user",
//               content: `
// Answer the question using resume information.

// Question: ${question}

// Resume:
// ${fullText}

// Rules:
// - Extract directly from resume
// - Understand vague questions:
//   "degree" → education
//   "experience" → work experience
//   "role" → job title
// - If multiple answers exist, list them clearly
// - Be concise
// - DO NOT say "not found" unless absolutely missing
// `,
//             },
//           ],
//         }),
//       },
//     );

//     const data = await response.json();

//     return res.json({
//       question,
//       answer: data.choices[0].message.content,
//     });
//   }

//   try {
//     // Step 1 — embed the question
//     console.log("Embedding question...");
//     const questionEmbedding = await getEmbedding(question);

//     // Step 2 — find similar chunks using Vector Search
//     console.log("Searching MongoDB Atlas...");
//     const relevantChunks = await Chunk.aggregate([
//       {
//         $vectorSearch: {
//           index: "vector_index",
//           path: "embedding",
//           queryVector: questionEmbedding,
//           numCandidates: 50,
//           limit: 10, // top most relevant chunks
//           filter: { userId: { $eq: req.userId } }, // only this user's chunks
//         },
//       },
//       {
//         $project: {
//           text: 1,
//           source: 1,
//           score: { $meta: "vectorSearchScore" },
//         },
//       },
//       { $limit: 3 },
//     ]);

//     const filteredChunks = relevantChunks.filter((c) => c.score > 0.6);

//     console.log(`Found ${relevantChunks.length} relevant chunks`);
//     relevantChunks.forEach((c, i) => {
//       console.log(`Chunk ${i + 1} score: ${c.score?.toFixed(3)}`);
//     });

//     if (relevantChunks.length === 0) {
//       // TEMP DEBUG — fetch all chunks manually
//       console.log("Vector search returned 0 — fetching all chunks as fallback");
//       const allChunks = await Chunk.find({ userId: req.userId });
//       console.log(`Total chunks in DB: ${allChunks.length}`);
//       allChunks.forEach((c, i) =>
//         console.log(`DB Chunk ${i + 1}: ${c.text.substring(0, 80)}`),
//       );

//       return res.json({
//         answer:
//           "Vector search returned 0 results. Check terminal for debug info.",
//         debug: { totalChunksInDB: allChunks.length },
//       });
//     }

//     // Debug — see exactly what chunks are being sent to AI
//     relevantChunks.forEach((c, i) => {
//       console.log(`\nCHUNK ${i + 1} TEXT:\n${c.text}\n`);
//     });
//     // Step 3 — build prompt with chunks as context
//     const context =
//       filteredChunks.length > 0
//         ? filteredChunks.map((c) => c.text).join("\n\n")
//         : relevantChunks.map((c) => c.text).join("\n\n");

//     const prompt = `You are a resume assistant.

// The context may contain formatting issues or merged words.
// Carefully interpret the meaning.

// Answer ONLY if clearly supported by context.
// Do NOT guess.

// If the answer is not in the context, say:
// "I don't find that information in the document."

// CONTEXT:
// ${context}

// QUESTION: ${question}

// Rules:
// - Answer ONLY what was asked
// - Be concise
// - Do not include unrelated information`;

//     console.log("Calling LLM...");

//     // Step 4 — ask AI
//     const response = await fetch(
//       "https://openrouter.ai/api/v1/chat/completions",
//       {
//         method: "POST",
//         headers: {
//           Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
//           "Content-Type": "application/json",
//         },
//         body: JSON.stringify({
//           model: "openai/gpt-3.5-turbo",
//           messages: [{ role: "user", content: prompt }],
//         }),
//       },
//     );

//     console.log("LLM responded");

//     const data = await response.json();
//     const answer = data.choices[0].message.content;

//     res.json({
//       question,
//       answer,
//       chunksUsed: relevantChunks.length,
//       sources: (filteredChunks.length > 0
//         ? filteredChunks
//         : relevantChunks
//       ).map((c) => ({
//         source: c.source,
//         score: c.score?.toFixed(3),
//         preview: c.text.substring(0, 100) + "...",
//       })),
//     });
//   } catch (error) {
//     console.error("Ask error:", error);
//     res.status(500).json({ error: error.message });
//   }
// });

// ─── ROUTE 3: Extract structured profile from resume

app.post("/extract-profile", authMiddleware, async (req, res) => {

  console.log("EXTRACT BODY:", req.body);
  try {
    if (!req.body || !req.body.filename) {
      return res.status(400).json({ error: "Filename is required" });
    }

    const { filename } = req.body;

    const chunks = await Chunk.find({
      source: filename,
      userId: req.userId,
    });

    if (chunks.length === 0) {
      return res.status(404).json({ error: "No resume found. Upload first." });
    }

    // Combine all chunks into full text
    const fullText = chunks.map((c) => c.text).join("\n");

    // Ask AI to extract structured data — key is the prompt
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content: `You are a resume parser. Extract information and respond ONLY with valid JSON.
No explanation. No markdown. No code blocks. Just raw JSON.`,
            },
            {
              role: "user",
              content: `Extract structured data from this resume.

Return ONLY valid JSON in this exact format:

{
  "name": "",
  "title": "",
  "email": "",
  "phone": "",
  "summary": "",
  "skills": [],
  "projects": [
    {
      "name": "",
      "description": ""
    }
  ],
  "education": ""
}

Rules:
- MUST be valid JSON
- Always include all keys
- skills must be an array of strings
- projects must be array of objects
- Do NOT skip brackets or quotes

RESUME TEXT:
${fullText}`,
            },
          ],
        }),
      },
    );

    const data = await response.json();
    const rawText = data.choices[0].message.content;

    console.log("Raw AI response:", rawText);

    // Parse the JSON — this is why we told AI to return ONLY JSON

    // const profile = JSON.parse(rawText);

    // Clean control characters before parsing
    const cleaned = rawText.replace(/[\x00-\x1F\x7F]/g, " ");
    const profile = JSON.parse(cleaned);

    res.json({ profile });
  } catch (error) {
    console.error("Extract error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => {
  res.send("Server is running");
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Resume bot running on port ${PORT}`);
});
