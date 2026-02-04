/**
 * AI Summary Service
 * Generates AI-powered summaries for chatroom conversations
 */

const config = require('../config');

// OpenAI client singleton
const OPENAI_API_KEY = config.ai.openaiApiKey;
let _openaiClient = null;

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
function getOpenAIClient() {
  if (!OPENAI_API_KEY) {
    throw new Error("openai_not_configured");
  }
  if (!_openaiClient) {
    try {
      const OpenAI = require("openai");
      _openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
    } catch (e) {
      throw new Error("openai_sdk_not_installed");
    }
  }
  return _openaiClient;
}

/**
 * Generate AI summary for chatroom messages
 * @param {Object} data - Summary input data
 * @param {Array} data.messages - Array of messages with content, author_name, created_at
 * @param {Object} data.candidate - Candidate info (name, email)
 * @param {string} data.jobTitle - Job title
 * @param {Object} data.dateRange - Date range info { label, startDate, endDate }
 * @returns {Promise<Object>} Structured summary object
 */
async function generateChatroomSummary(data) {
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

  const client = getOpenAIClient();
  const modelName = config.ai.openaiModel || "gpt-4o-mini";

  // Build conversation text for AI
  const conversationText = messages
    .map((m) => `[${m.author_name || "Unknown"}]: ${m.content}`)
    .join("\n");

  const uniqueParticipants = [
    ...new Set(messages.map((m) => m.author_name || m.author_email || "Unknown")),
  ];

  const systemPrompt = `You are an expert at analyzing professional workplace conversations.
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

  const userContext = `CANDIDATE: ${candidate?.name || "Unknown"}
JOB POSITION: ${jobTitle || "Not specified"}
DATE RANGE: ${dateRange?.label || "All messages"}
PARTICIPANTS: ${uniqueParticipants.join(", ")}
TOTAL MESSAGES: ${messages.length}

CONVERSATION:
${conversationText.slice(0, 15000)}`;

  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "chatroom_summary",
      strict: true,
      schema: {
        type: "object",
        properties: {
          keyDiscussionPoints: {
            type: "array",
            items: { type: "string" },
          },
          decisionsMade: {
            type: "array",
            items: { type: "string" },
          },
          actionItems: {
            type: "array",
            items: {
              type: "object",
              properties: {
                task: { type: "string" },
                owner: { type: "string" },
              },
              required: ["task", "owner"],
              additionalProperties: false,
            },
          },
          participantInsights: {
            type: "array",
            items: {
              type: "object",
              properties: {
                participant: { type: "string" },
                insight: { type: "string" },
              },
              required: ["participant", "insight"],
              additionalProperties: false,
            },
          },
          overallSentiment: {
            type: "string",
            enum: ["positive", "neutral", "mixed", "concerns"],
          },
          notableQuotes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                quote: { type: "string" },
                author: { type: "string" },
              },
              required: ["quote", "author"],
              additionalProperties: false,
            },
          },
        },
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

  let jsonText = "";
  try {
    console.log("[AISummary] Generating summary for chatroom:", {
      candidateName: candidate?.name,
      messageCount: messages.length,
      participantCount: uniqueParticipants.length,
    });

    const completion = await client.chat.completions.create({
      model: modelName,
      temperature: 0.3,
      max_tokens: 2048,
      response_format: responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContext },
      ],
    });

    jsonText = completion?.choices?.[0]?.message?.content || "";

    if (!jsonText) {
      const err = new Error("openai_empty_response");
      err.detail = "OpenAI returned an empty response.";
      throw err;
    }
  } catch (e) {
    console.error("[AISummary] Generation error:", e);
    const err = new Error("openai_generation_failed");
    err.detail = e?.message || "OpenAI API call failed.";
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
      const err = new Error("invalid_openai_json");
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
 */
function isConfigured() {
  return !!OPENAI_API_KEY;
}

module.exports = {
  generateChatroomSummary,
  isConfigured,
};
