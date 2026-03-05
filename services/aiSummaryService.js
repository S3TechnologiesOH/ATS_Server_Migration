/**
 * AI Summary Service
 * Generates AI-powered summaries for chatroom conversations
 * Supports OpenAI and Google Gemini providers
 */

const config = require('../config');

// OpenAI client singleton
const OPENAI_API_KEY = config.ai.openaiApiKey;
let _openaiClient = null;

// Google Gemini client singleton
let _googleClient = null;

// JSON repair utility
let jsonrepairFn = null;
try {
  const jr = require("jsonrepair");
  if (typeof jr === "function") jsonrepairFn = jr;
  else if (jr && typeof jr.jsonrepair === "function")
    jsonrepairFn = jr.jsonrepair;
} catch {}

/**
 * Get or create OpenAI client
 */
function getOpenAIClient(apiKey) {
  const key = apiKey || OPENAI_API_KEY;
  if (!key) {
    throw new Error("openai_not_configured");
  }
  // If a custom key is provided, create a new client (don't cache tenant-specific keys)
  if (apiKey && apiKey !== OPENAI_API_KEY) {
    try {
      const OpenAI = require("openai");
      return new OpenAI({ apiKey });
    } catch (e) {
      throw new Error("openai_sdk_not_installed");
    }
  }
  if (!_openaiClient) {
    try {
      const OpenAI = require("openai");
      _openaiClient = new OpenAI({ apiKey: key });
    } catch (e) {
      throw new Error("openai_sdk_not_installed");
    }
  }
  return _openaiClient;
}

/**
 * Get or create Google Gemini client
 */
function getGoogleClient(apiKey) {
  const key = apiKey || config.ai.googleApiKey;
  if (!key) {
    throw new Error("google_ai_not_configured");
  }
  if (apiKey && apiKey !== config.ai.googleApiKey) {
    try {
      const { GoogleGenerativeAI } = require("@google/generative-ai");
      return new GoogleGenerativeAI(key);
    } catch (e) {
      throw new Error("google_ai_sdk_not_installed");
    }
  }
  if (!_googleClient) {
    try {
      const { GoogleGenerativeAI } = require("@google/generative-ai");
      _googleClient = new GoogleGenerativeAI(key);
    } catch (e) {
      throw new Error("google_ai_sdk_not_installed");
    }
  }
  return _googleClient;
}

// Summary JSON schema definition (shared between providers)
const SUMMARY_SCHEMA = {
  keyDiscussionPoints: { type: "array", items: { type: "string" } },
  decisionsMade: { type: "array", items: { type: "string" } },
  actionItems: {
    type: "array",
    items: {
      type: "object",
      properties: { task: { type: "string" }, owner: { type: "string" } },
      required: ["task", "owner"],
    },
  },
  participantInsights: {
    type: "array",
    items: {
      type: "object",
      properties: { participant: { type: "string" }, insight: { type: "string" } },
      required: ["participant", "insight"],
    },
  },
  overallSentiment: { type: "string", enum: ["positive", "neutral", "mixed", "concerns"] },
  notableQuotes: {
    type: "array",
    items: {
      type: "object",
      properties: { quote: { type: "string" }, author: { type: "string" } },
      required: ["quote", "author"],
    },
  },
};

const SYSTEM_PROMPT = `You are an expert at analyzing professional workplace conversations.
Your task is to summarize a chatroom conversation about a job candidate.

Analyze the conversation and extract:
1. KEY_DISCUSSION_POINTS: Main topics discussed (3-7 bullet points)
2. DECISIONS_MADE: Any conclusions or decisions reached (0-5 items)
3. ACTION_ITEMS: Tasks or follow-ups identified with owner if mentioned (0-5 items)
4. PARTICIPANT_INSIGHTS: Notable observations from specific participants (2-4 items)
5. OVERALL_SENTIMENT: Assessment of the conversation tone (positive/neutral/mixed/concerns)
6. NOTABLE_QUOTES: 2-3 significant direct quotes that capture key points

Be concise, professional, and objective. Focus on hiring-relevant information.
Return ONLY valid JSON matching the response schema.`;

/**
 * Generate summary using OpenAI
 */
async function generateWithOpenAI(userContext, modelName, apiKey) {
  const client = getOpenAIClient(apiKey);

  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "chatroom_summary",
      strict: true,
      schema: {
        type: "object",
        properties: SUMMARY_SCHEMA,
        required: [
          "keyDiscussionPoints",
          "decisionsMade",
          "actionItems",
          "participantInsights",
          "overallSentiment",
          "notableQuotes",
        ],
        additionalProperties: false,
      },
    },
  };

  const completion = await client.chat.completions.create({
    model: modelName,
    temperature: 0.3,
    max_tokens: 2048,
    response_format: responseFormat,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContext },
    ],
  });

  return completion?.choices?.[0]?.message?.content || "";
}

/**
 * Generate summary using Google Gemini
 */
async function generateWithGoogle(userContext, modelName, apiKey) {
  const client = getGoogleClient(apiKey);
  const model = client.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  });

  const prompt = `${SYSTEM_PROMPT}\n\n${userContext}`;
  const result = await model.generateContent(prompt);
  const response = result.response;
  return response.text() || "";
}

/**
 * Generate AI summary for chatroom messages
 * @param {Object} data - Summary input data
 * @param {Array} data.messages - Array of messages with content, author_name, created_at
 * @param {Object} data.candidate - Candidate info (name, email)
 * @param {string} data.jobTitle - Job title
 * @param {Object} data.dateRange - Date range info { label, startDate, endDate }
 * @param {Object} [aiConfig] - Optional tenant AI config { provider, model, apiKey }
 * @returns {Promise<Object>} Structured summary object
 */
async function generateChatroomSummary(data, aiConfig) {
  const { messages, candidate, jobTitle, dateRange } = data;

  // Handle empty messages
  if (!messages || messages.length === 0) {
    return {
      keyDiscussionPoints: [],
      decisionsMade: [],
      actionItems: [],
      participantInsights: [],
      overallSentiment: "neutral",
      notableQuotes: [],
      messageCount: 0,
      participantCount: 0,
      participants: [],
    };
  }

  // Resolve provider config
  const provider = aiConfig?.provider || "openai";
  const modelName = aiConfig?.model || config.ai.openaiModel || "gpt-4o-mini";
  const apiKey = aiConfig?.apiKey || undefined;

  // Build conversation text for AI
  const conversationText = messages
    .map((m) => `[${m.author_name || "Unknown"}]: ${m.content}`)
    .join("\n");

  const uniqueParticipants = [
    ...new Set(messages.map((m) => m.author_name || m.author_email || "Unknown")),
  ];

  const userContext = `CANDIDATE: ${candidate?.name || "Unknown"}
JOB POSITION: ${jobTitle || "Not specified"}
DATE RANGE: ${dateRange?.label || "All messages"}
PARTICIPANTS: ${uniqueParticipants.join(", ")}
TOTAL MESSAGES: ${messages.length}

CONVERSATION:
${conversationText.slice(0, 15000)}`;

  let jsonText = "";
  try {
    console.log("[AISummary] Generating summary for chatroom:", {
      provider,
      model: modelName,
      candidateName: candidate?.name,
      messageCount: messages.length,
      participantCount: uniqueParticipants.length,
    });

    if (provider === "google") {
      jsonText = await generateWithGoogle(userContext, modelName, apiKey);
    } else {
      jsonText = await generateWithOpenAI(userContext, modelName, apiKey);
    }

    if (!jsonText) {
      const err = new Error("ai_empty_response");
      err.detail = `${provider} returned an empty response.`;
      throw err;
    }
  } catch (e) {
    console.error("[AISummary] Generation error:", e);
    const err = new Error("ai_generation_failed");
    err.detail = e?.message || `${provider} API call failed.`;
    err.cause = e;
    throw err;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(jsonText);
  } catch (parseErr) {
    if (jsonrepairFn) {
      try {
        const repairedText = jsonrepairFn(jsonText);
        parsed = JSON.parse(repairedText);
      } catch {}
    }
    if (!parsed) {
      const err = new Error("invalid_ai_json");
      err.detail = `Parse error: ${parseErr.message}`;
      throw err;
    }
  }

  // Return summary with metadata
  return {
    ...parsed,
    messageCount: messages.length,
    participantCount: uniqueParticipants.length,
    participants: uniqueParticipants,
  };
}

/**
 * Check if AI summary service is configured
 * @param {Object} [aiConfig] - Optional tenant AI config
 */
function isConfigured(aiConfig) {
  if (aiConfig) {
    return !!aiConfig.apiKey;
  }
  return !!OPENAI_API_KEY;
}

module.exports = {
  generateChatroomSummary,
  isConfigured,
};
