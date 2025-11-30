"use strict";

const http = require("http");
const https = require("https");

const PORT = Number(process.env.PORT) || 8787;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-pro";
const GEMINI_BASE = process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1";
const DEFAULT_IMAGE = "https://i5.samsclubimages.com/asr/e88cd487-1e1b-4373-9808-de4484446960.89a37ef2c5eeab632d4297cc90162d61.jpeg?odnHeight=640&odnWidth=640&odnBg=FFFFFF";
const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15MB

if (!GEMINI_API_KEY) {
    console.error("Missing GEMINI_API_KEY (or GOOGLE_API_KEY). Set it before starting the proxy.");
    process.exit(1);
}

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const readRequestBody = (req) =>
    new Promise((resolve, reject) => {
        let body = "";
        let bytes = 0;
        req.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) {
                reject(new Error("Payload too large"));
                req.destroy();
                return;
            }
            body += chunk;
        });
        req.on("end", () => resolve(body));
        req.on("error", reject);
    });

const fromDataUrl = (dataUrl) => {
    const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
    if (!match) return null;
    return { mimeType: match[1], data: match[2] };
};

const fetchImageAsInlineData = async (imageData) => {
    if (typeof imageData === "string" && imageData.startsWith("data:")) {
        const parsed = fromDataUrl(imageData);
        if (parsed) return { mimeType: parsed.mimeType, data: parsed.data };
    }

    const targetUrl = imageData || DEFAULT_IMAGE;
    const response = await fetch(targetUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch image (${response.status})`);
    }
    const mimeType = response.headers.get("content-type") || "image/jpeg";
    const buffer = await response.arrayBuffer();
    return {
        mimeType,
        data: Buffer.from(buffer).toString("base64")
    };
};

const callGemini = async ({ imageData, model }) => {
    const targetModel = (model || GEMINI_MODEL).replace(/^models\//, "");
    const inlineData = await fetchImageAsInlineData(imageData);
    const prompt = `You are a grocery produce quality specialist. Inspect the attached produce photo, identify the produce type, and evaluate it.
Return ONLY valid JSON with keys: produceName (string), ripeness (1-5), freshness (1-5), confidence (0-100),
shelfLife (string), defects (string, <=20 words), summary (string), estimatedPrice (number in USD). Example:
{"produceName":"Banana","ripeness":4,"freshness":5,"confidence":92,"shelfLife":"3-4 days","defects":"No visible blemishes","summary":"Text","estimatedPrice":0.79}.`;

    const url = `${GEMINI_BASE}/models/${encodeURIComponent(targetModel)}:generateContent?key=${GEMINI_API_KEY}`;
    const body = {
        contents: [
            {
                role: "user",
                parts: [
                    { text: prompt },
                    { inlineData }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1200,
            responseMimeType: "application/json"
        }
    };

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = payload?.error?.message || payload?.message || "Gemini request failed.";
        const err = new Error(message);
        err.status = response.status;
        err.payload = payload;
        throw err;
    }

    const candidate = payload.candidates?.[0];
    const combined = candidate?.content?.parts
        ?.map((part) => part.text || "")
        .filter(Boolean)
        .join("\n")
        .trim() || "";

    return {
        status: 200,
        body: {
            provider: "gemini",
            choices: [
                {
                    message: {
                        content: combined
                    }
                }
            ],
            raw: payload
        }
    };
};

const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    if (req.method === "POST" && req.url === "/analyze") {
        let rawBody = "";
        try {
            rawBody = await readRequestBody(req);
        } catch (err) {
            res.writeHead(413, { ...corsHeaders, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
            return;
        }

        let payload;
        try {
            payload = rawBody ? JSON.parse(rawBody) : {};
        } catch {
            res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON payload." }));
            return;
        }

        const { imageData, model } = payload || {};

        try {
            const geminiResult = await callGemini({
                imageData,
                model: model || GEMINI_MODEL
            });

            res.writeHead(geminiResult.status, { ...corsHeaders, "Content-Type": "application/json" });
            res.end(JSON.stringify(geminiResult.body));
        } catch (err) {
            console.error("Proxy error", err);
            const status = err.status || 500;
            const message = err.message || "Gemini request failed.";
            res.writeHead(status, { ...corsHeaders, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: message, details: err.payload || null }));
        }
        return;
    }

    res.writeHead(404, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
    console.log(`Local proxy listening on http://localhost:${PORT}/analyze`);
});

