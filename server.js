require("dotenv").config();
const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("MCP Google server activo");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor iniciado");
});
