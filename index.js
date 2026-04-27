require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const pdf = require("pdf-parse");
console.log(typeof pdf);
const fetch = require("node-fetch");
const cors = require("cors");
const Chunk = require("./models/Chunk");

console.log("API KEY:", process.env.OPENROUTER_API_KEY ? "EXISTS" : "MISSING");
console.log("MONGO URI:", process.env.MONGODB_URI ? "EXISTS" : "MISSING");

const app = express();
app.use(express.json());
app.use(cors());

// Connect to MongoDB Atlas
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB Atlas connected!"))
  .catch((err) => console.error("MongoDB error:", err));

// Multer — store PDF in memory, not disk
const upload = multer({ storage: multer.memoryStorage() });

// ─── HELPER: Get embedding for any text ───────────────────────────────────────
async function getEmbedding(text) {
  console.log("➡️ Calling embedding API...");
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-ada-002",
      input: text,
    }),
  });

  const data = await response.json();
  console.log("⬅️ Embedding API response:", JSON.stringify(data).substring(0, 200));

  // Guard against unexpected response
  if (!data.data || !data.data[0]) {
    console.error("❌ Unexpected embedding response:", JSON.stringify(data));
    throw new Error(`Embedding API error: ${JSON.stringify(data)}`);
  }

  return data.data[0].embedding;
}

// ─── HELPER: Split text into chunks ───────────────────────────────────────────
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

// ─── ROUTE 1: Upload PDF ───────────────────────────────────────────────────────
app.post("/upload", upload.single("pdf"), async (req, res) => {
  try {
    console.log("PDF received, extracting text...");

    // Step 1 — extract text from PDF
    const pdfData = await pdf(req.file.buffer);
    const fullText = pdfData.text;
    console.log(`Extracted ${fullText.length} characters`);
    console.log("FULL TEXT:", fullText);

    // Step 2 — split into chunks
    const chunks = splitIntoChunks(fullText, 200);
    console.log(`Split into ${chunks.length} chunks`);

    // Step 3 — embed each chunk and save to MongoDB
    const filename = req.file.originalname;

    // Delete old chunks for this file first
    await Chunk.deleteMany({ source: filename });

    // for (let i = 0; i < chunks.length; i++) {
    //   console.log(`Embedding chunk ${i + 1}/${chunks.length}...`);

    //   const embedding = await getEmbedding(chunks[i]);

    //   console.log("💾 Saving to MongoDB...");

    //   await Chunk.create({
    //     text: chunks[i],
    //     embedding,
    //     source: filename,
    //     chunkIndex: i,
    //   });

    //   console.log("✅ Saved to MongoDB");
    // }
    console.log("⚡ Running embeddings in parallel...");

    const embeddings = await Promise.all(
      chunks.map((chunk, i) => {
        console.log(`Embedding chunk ${i + 1}/${chunks.length}`);
        return getEmbedding(chunk);
      }),
    );

    console.log("💾 Saving all chunks to MongoDB...");

    await Promise.all(
      embeddings.map((embedding, i) => {
        return Chunk.create({
          text: chunks[i],
          embedding,
          source: filename,
          chunkIndex: i,
        });
      }),
    );

    console.log("✅ All chunks saved");

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

// ─── ROUTE 2: Ask a question ───────────────────────────────────────────────────
app.post("/ask", async (req, res) => {
  const { question } = req.body;

  if (!question) {
    return res.status(400).json({ error: "Please send a question" });
  }

  try {
    // Step 1 — embed the question
    console.log("Embedding question...");
    const questionEmbedding = await getEmbedding(question);

    // Step 2 — find similar chunks using Vector Search
    console.log("Searching MongoDB Atlas...");
    const relevantChunks = await Chunk.aggregate([
      {
        $vectorSearch: {
          index: "vector_index",
          path: "embedding",
          queryVector: questionEmbedding,
          numCandidates: 50,
          limit: 3, // top 3 most relevant chunks
        },
      },
      {
        $project: {
          text: 1,
          source: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ]);

    console.log(`Found ${relevantChunks.length} relevant chunks`);
    relevantChunks.forEach((c, i) => {
      console.log(`Chunk ${i + 1} score: ${c.score?.toFixed(3)}`);
    });

    if (relevantChunks.length === 0) {
      // TEMP DEBUG — fetch all chunks manually
      console.log("Vector search returned 0 — fetching all chunks as fallback");
      const allChunks = await Chunk.find({});
      console.log(`Total chunks in DB: ${allChunks.length}`);
      allChunks.forEach((c, i) =>
        console.log(`DB Chunk ${i + 1}: ${c.text.substring(0, 80)}`),
      );

      return res.json({
        answer:
          "Vector search returned 0 results. Check terminal for debug info.",
        debug: { totalChunksInDB: allChunks.length },
      });
    }

    // Debug — see exactly what chunks are being sent to AI
    relevantChunks.forEach((c, i) => {
      console.log(`\nCHUNK ${i + 1} TEXT:\n${c.text}\n`);
    });
    // Step 3 — build prompt with chunks as context
    const context = relevantChunks.map((c) => c.text).join("\n\n---\n\n");

    const prompt = `You are a resume assistant. You are given chunks of text extracted from a resume.
Answer the question using the information in the context below.
The context may have formatting issues or line breaks — ignore them and extract the meaning.
If you truly cannot find the answer, say "I don't find that information in the document."

CONTEXT:
${context}

QUESTION: ${question}

Answer directly and concisely based on the context above.`;

    console.log("🧠 Calling LLM...");

    // Step 4 — ask AI
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
          messages: [{ role: "user", content: prompt }],
        }),
      },
    );

    console.log("📥 LLM responded");

    const data = await response.json();
    const answer = data.choices[0].message.content;

    res.json({
      question,
      answer,
      chunksUsed: relevantChunks.length,
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

// ─── ROUTE 3: Extract structured profile from resume

app.post("/extract-profile", async (req, res) => {
  try {
    // Load all chunks from MongoDB for this resume
    const chunks = await Chunk.find({ source: req.body.filename });

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
              content: `Extract the following from this resume text and return as JSON:
              {
              "name": "full name",
              "title": "job title",
              "email": "email address",
              "phone": "phone number",
              "summary": "professional summary",
              "skills": ["skill1", "skill2"],
              "projects": [{"name": "project name", "description": "what it does"}],
              "education": "degree and insitution"
              }
              
              RESUME TEXT:
              ${fullText}
              
              Return ONLY the JSON object. Nothing else.`,
            },
          ],
        }),
      },
    );

    const data = await response.json();
    const rawText = data.choices[0].message.content;

    console.log("Raw AI response:", rawText);

    // Parse the JSON — this is why we told AI to return ONLY JSON

    const profile = JSON.parse(rawText);

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
