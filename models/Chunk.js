const mongoose = require("mongoose");

const chunkSchema = new mongoose.Schema(
  {
    text: String, // the actual text chunk
    embedding: [Number], // vector — 1536 numbers representing meaning
    source: String, // filename — which PDF this came from
    chunkIndex: Number, // position in the document
    userId: String
  },
  { timestamps: true },
);

module.exports = mongoose.model("Chunk", chunkSchema);
