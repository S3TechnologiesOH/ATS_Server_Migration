/**
 * PDF Service
 * Generates professional candidate profile PDFs with tenant branding
 */

const PDFDocument = require("pdfkit");
const axios = require("axios");

// Color utilities
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [
        parseInt(result[1], 16),
        parseInt(result[2], 16),
        parseInt(result[3], 16),
      ]
    : [45, 90, 39]; // Default green
}

function darkenColor(hex, percent = 20) {
  const rgb = hexToRgb(hex);
  return rgb.map((c) => Math.max(0, Math.floor(c * (1 - percent / 100))));
}

/**
 * Fetch image as buffer for embedding in PDF
 */
async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 10000,
    });
    return Buffer.from(response.data);
  } catch (e) {
    console.warn(`[PDFService] Failed to fetch image: ${url}`, e.message);
    return null;
  }
}

/**
 * Draw a score bar visualization
 */
function drawScoreBar(doc, x, y, score, width = 150, height = 12, primaryColor) {
  const fillWidth = (score / 100) * width;
  const rgb = hexToRgb(primaryColor);

  // Background bar
  doc.rect(x, y, width, height).fill("#e5e7eb");

  // Filled portion
  doc.rect(x, y, fillWidth, height).fill(rgb);

  // Score text
  doc
    .fontSize(10)
    .fillColor("#374151")
    .text(`${score}`, x + width + 8, y + 1, { width: 30 });
}

/**
 * Get score label based on value
 */
function getScoreLabel(score) {
  if (score >= 90) return { label: "Excellent", color: "#059669" };
  if (score >= 80) return { label: "Very Good", color: "#10b981" };
  if (score >= 70) return { label: "Good", color: "#3b82f6" };
  if (score >= 60) return { label: "Fair", color: "#f59e0b" };
  return { label: "Needs Review", color: "#ef4444" };
}

/**
 * Generate candidate profile PDF
 *
 * @param {Object} data - All candidate data
 * @param {Object} data.candidate - Candidate VM (name, email, phone, location, etc.)
 * @param {Object} data.score - AI evaluation score
 * @param {Object} data.interviewQuestions - Interview questions data
 * @param {string} data.professionalSummary - AI-generated summary
 * @param {string} data.resumeHighlights - Key points from resume
 * @param {Object} branding - Tenant branding
 * @param {string} branding.companyName - Company name
 * @param {string} branding.logoUrl - Logo URL
 * @param {string} branding.primaryColor - Primary brand color
 * @param {Object} options - What sections to include
 * @returns {Promise<Buffer>} PDF as buffer
 */
async function generateCandidateProfilePDF(data, branding, options = {}) {
  const {
    candidate,
    score,
    interviewQuestions,
    professionalSummary,
    resumeHighlights,
  } = data;

  const {
    companyName = "Company",
    logoUrl = null,
    primaryColor = "#2d5a27",
  } = branding || {};

  const {
    includePersonalInfo = true,
    includeJobDetails = true,
    includeAiEvaluation = true,
    includeProfessionalSummary = true,
    includeInterviewQuestions = true,
    includeResumeHighlights = true,
  } = options;

  // Create PDF document
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    bufferPages: true,
  });

  // Collect PDF data into buffer
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));

  const primaryRgb = hexToRgb(primaryColor);
  const darkRgb = darkenColor(primaryColor, 30);

  // Fetch logo if available
  let logoBuffer = null;
  if (logoUrl) {
    logoBuffer = await fetchImageBuffer(logoUrl);
  }

  // ==================== HEADER ====================
  const headerY = 40;

  // Logo (left side)
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, 50, headerY, { height: 40 });
    } catch (e) {
      console.warn("[PDFService] Failed to embed logo:", e.message);
    }
  }

  // Company name (right side)
  doc
    .fontSize(16)
    .fillColor(primaryRgb)
    .text(companyName.toUpperCase(), 300, headerY + 10, {
      align: "right",
      width: 245,
    });

  // Header line
  doc
    .moveTo(50, headerY + 50)
    .lineTo(562, headerY + 50)
    .strokeColor(primaryRgb)
    .lineWidth(2)
    .stroke();

  // ==================== TITLE ====================
  let currentY = headerY + 70;

  doc
    .fontSize(24)
    .fillColor(darkRgb)
    .text("CANDIDATE PROFILE", 50, currentY, { align: "center" });

  currentY += 40;

  // Candidate name
  doc
    .fontSize(18)
    .fillColor("#1f2937")
    .text(candidate?.name || "Unknown Candidate", 50, currentY, {
      align: "center",
    });

  currentY += 35;

  // ==================== PERSONAL INFORMATION ====================
  if (includePersonalInfo) {
    doc
      .fontSize(14)
      .fillColor(primaryRgb)
      .text("PERSONAL INFORMATION", 50, currentY);

    currentY += 5;
    doc
      .moveTo(50, currentY + 15)
      .lineTo(250, currentY + 15)
      .strokeColor("#d1d5db")
      .lineWidth(1)
      .stroke();

    currentY += 25;

    const personalInfo = [
      { label: "Email", value: candidate?.email || "N/A" },
      { label: "Phone", value: candidate?.phone || "N/A" },
      { label: "Location", value: candidate?.location || "N/A" },
    ];

    personalInfo.forEach((item) => {
      doc.fontSize(10).fillColor("#6b7280").text(item.label + ":", 50, currentY);
      doc.fontSize(10).fillColor("#1f2937").text(item.value, 130, currentY);
      currentY += 18;
    });

    currentY += 15;
  }

  // ==================== JOB DETAILS ====================
  if (includeJobDetails) {
    // Check if we need a new page
    if (currentY > 650) {
      doc.addPage();
      currentY = 50;
    }

    doc.fontSize(14).fillColor(primaryRgb).text("JOB DETAILS", 50, currentY);

    currentY += 5;
    doc
      .moveTo(50, currentY + 15)
      .lineTo(200, currentY + 15)
      .strokeColor("#d1d5db")
      .lineWidth(1)
      .stroke();

    currentY += 25;

    const jobInfo = [
      { label: "Applied Position", value: candidate?.jobTitle || "N/A" },
      {
        label: "Application Date",
        value: candidate?.appliedAt
          ? new Date(candidate.appliedAt).toLocaleDateString()
          : "N/A",
      },
      { label: "Source", value: candidate?.source || "N/A" },
    ];

    jobInfo.forEach((item) => {
      doc.fontSize(10).fillColor("#6b7280").text(item.label + ":", 50, currentY);
      doc.fontSize(10).fillColor("#1f2937").text(item.value, 160, currentY);
      currentY += 18;
    });

    currentY += 15;
  }

  // ==================== PROFESSIONAL SUMMARY ====================
  if (includeProfessionalSummary && professionalSummary) {
    if (currentY > 550) {
      doc.addPage();
      currentY = 50;
    }

    doc
      .fontSize(14)
      .fillColor(primaryRgb)
      .text("PROFESSIONAL SUMMARY", 50, currentY);

    currentY += 5;
    doc
      .moveTo(50, currentY + 15)
      .lineTo(280, currentY + 15)
      .strokeColor("#d1d5db")
      .lineWidth(1)
      .stroke();

    currentY += 25;

    doc
      .fontSize(10)
      .fillColor("#374151")
      .text(professionalSummary, 50, currentY, {
        width: 512,
        align: "justify",
        lineGap: 4,
      });

    currentY = doc.y + 20;
  }

  // ==================== AI EVALUATION ====================
  if (includeAiEvaluation && score) {
    if (currentY > 450) {
      doc.addPage();
      currentY = 50;
    }

    doc.fontSize(14).fillColor(primaryRgb).text("AI EVALUATION", 50, currentY);

    currentY += 5;
    doc
      .moveTo(50, currentY + 15)
      .lineTo(200, currentY + 15)
      .strokeColor("#d1d5db")
      .lineWidth(1)
      .stroke();

    currentY += 30;

    // Overall score with visual
    const overallScore = score.overall_score || 0;
    const scoreInfo = getScoreLabel(overallScore);

    doc.fontSize(12).fillColor("#1f2937").text("Overall Score:", 50, currentY);

    drawScoreBar(doc, 150, currentY, overallScore, 150, 14, primaryColor);

    doc
      .fontSize(10)
      .fillColor(scoreInfo.color)
      .text(scoreInfo.label, 320, currentY + 2);

    currentY += 30;

    // Score breakdown
    const scores = [
      { label: "Experience Fit", value: score.experience_fit },
      { label: "Skills Match", value: score.skills_fit },
      { label: "Culture Fit", value: score.culture_fit },
    ];

    scores.forEach((s) => {
      if (s.value !== null && s.value !== undefined) {
        doc.fontSize(10).fillColor("#6b7280").text(s.label + ":", 50, currentY);
        drawScoreBar(doc, 150, currentY, s.value, 100, 10, primaryColor);
        currentY += 20;
      }
    });

    currentY += 10;

    // Strengths
    if (score.strengths && score.strengths.length > 0) {
      doc.fontSize(11).fillColor("#059669").text("Strengths:", 50, currentY);
      currentY += 18;

      score.strengths.forEach((strength) => {
        doc.fontSize(10).fillColor("#374151").text("• " + strength, 60, currentY, {
          width: 502,
        });
        currentY = doc.y + 5;
      });

      currentY += 10;
    }

    // Recommendations
    if (score.recommendations && score.recommendations.length > 0) {
      doc.fontSize(11).fillColor("#3b82f6").text("Recommendations:", 50, currentY);
      currentY += 18;

      score.recommendations.forEach((rec) => {
        doc.fontSize(10).fillColor("#374151").text("• " + rec, 60, currentY, {
          width: 502,
        });
        currentY = doc.y + 5;
      });

      currentY += 10;
    }

    // Risk flags
    if (score.risk_flags && score.risk_flags.length > 0) {
      doc.fontSize(11).fillColor("#ef4444").text("Areas of Concern:", 50, currentY);
      currentY += 18;

      score.risk_flags.forEach((flag) => {
        doc.fontSize(10).fillColor("#374151").text("• " + flag, 60, currentY, {
          width: 502,
        });
        currentY = doc.y + 5;
      });

      currentY += 10;
    }
  }

  // ==================== INTERVIEW QUESTIONS ====================
  if (includeInterviewQuestions && interviewQuestions?.questions?.length > 0) {
    if (currentY > 500) {
      doc.addPage();
      currentY = 50;
    }

    doc
      .fontSize(14)
      .fillColor(primaryRgb)
      .text("INTERVIEW QUESTIONS", 50, currentY);

    currentY += 5;
    doc
      .moveTo(50, currentY + 15)
      .lineTo(250, currentY + 15)
      .strokeColor("#d1d5db")
      .lineWidth(1)
      .stroke();

    currentY += 25;

    interviewQuestions.questions.slice(0, 8).forEach((q, i) => {
      if (currentY > 680) {
        doc.addPage();
        currentY = 50;
      }

      doc
        .fontSize(10)
        .fillColor("#1f2937")
        .text(`${i + 1}. ${q.question}`, 50, currentY, { width: 512 });

      currentY = doc.y + 5;

      if (q.category) {
        doc
          .fontSize(8)
          .fillColor("#9ca3af")
          .text(`Category: ${q.category}`, 60, currentY);
        currentY = doc.y + 10;
      }
    });

    currentY += 10;
  }

  // ==================== RESUME HIGHLIGHTS ====================
  if (includeResumeHighlights && resumeHighlights) {
    if (currentY > 500) {
      doc.addPage();
      currentY = 50;
    }

    doc
      .fontSize(14)
      .fillColor(primaryRgb)
      .text("RESUME HIGHLIGHTS", 50, currentY);

    currentY += 5;
    doc
      .moveTo(50, currentY + 15)
      .lineTo(230, currentY + 15)
      .strokeColor("#d1d5db")
      .lineWidth(1)
      .stroke();

    currentY += 25;

    // Truncate if too long
    const highlights =
      resumeHighlights.length > 2000
        ? resumeHighlights.substring(0, 2000) + "..."
        : resumeHighlights;

    doc.fontSize(9).fillColor("#374151").text(highlights, 50, currentY, {
      width: 512,
      lineGap: 3,
    });

    currentY = doc.y + 20;
  }

  // ==================== FOOTER ====================
  const pageCount = doc.bufferedPageRange().count;

  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);

    // Footer line
    doc
      .moveTo(50, 730)
      .lineTo(562, 730)
      .strokeColor("#d1d5db")
      .lineWidth(0.5)
      .stroke();

    // Footer text
    doc
      .fontSize(8)
      .fillColor("#9ca3af")
      .text(`Generated: ${new Date().toLocaleDateString()}`, 50, 738, {
        continued: true,
      })
      .text(` | Page ${i + 1} of ${pageCount}`, { continued: true })
      .text(" | CONFIDENTIAL", { align: "right" });
  }

  // Finalize PDF
  doc.end();

  // Wait for PDF to finish and return buffer
  return new Promise((resolve, reject) => {
    doc.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on("error", reject);
  });
}

/**
 * Generate chatroom transcript PDF
 *
 * @param {Object} data - Transcript data
 * @param {Object} data.chatroom - Chatroom info
 * @param {Object} data.candidate - Candidate info
 * @param {Array} data.messages - Array of messages
 * @param {Object} branding - Tenant branding
 * @param {Object} options - What to include
 * @returns {Promise<Buffer>} PDF as buffer
 */
async function generateChatroomTranscriptPDF(data, branding, options = {}) {
  const { chatroom, candidate, messages = [] } = data;

  const {
    companyName = "Company",
    logoUrl = null,
    primaryColor = "#2d5a27",
  } = branding || {};

  const {
    includeTimestamps = true,
    includeAuthors = true,
    includeCandidateHeader = true,
    includeNoteMentions = true,
  } = options;

  // Create PDF document
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 50, bottom: 60, left: 50, right: 50 },
    bufferPages: true,
  });

  // Collect PDF data into buffer
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));

  const primaryRgb = hexToRgb(primaryColor);
  const darkRgb = darkenColor(primaryColor, 30);

  // Fetch logo if available
  let logoBuffer = null;
  if (logoUrl) {
    logoBuffer = await fetchImageBuffer(logoUrl);
  }

  // ==================== HEADER ====================
  const headerY = 40;

  // Logo (left side)
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, 50, headerY, { height: 40 });
    } catch (e) {
      console.warn("[PDFService] Failed to embed logo:", e.message);
    }
  }

  // Company name (right side)
  doc
    .fontSize(16)
    .fillColor(primaryRgb)
    .text(companyName.toUpperCase(), 300, headerY + 10, {
      align: "right",
      width: 245,
    });

  // Header line
  doc
    .moveTo(50, headerY + 50)
    .lineTo(562, headerY + 50)
    .strokeColor(primaryRgb)
    .lineWidth(2)
    .stroke();

  // ==================== TITLE ====================
  let currentY = headerY + 70;

  doc
    .fontSize(20)
    .fillColor(darkRgb)
    .text("CHATROOM TRANSCRIPT", 50, currentY, { align: "center" });

  currentY += 35;

  // ==================== CANDIDATE HEADER ====================
  if (includeCandidateHeader && candidate) {
    doc
      .fontSize(14)
      .fillColor(primaryRgb)
      .text("CANDIDATE INFORMATION", 50, currentY);

    currentY += 5;
    doc
      .moveTo(50, currentY + 15)
      .lineTo(250, currentY + 15)
      .strokeColor("#d1d5db")
      .lineWidth(1)
      .stroke();

    currentY += 25;

    const candidateInfo = [
      { label: "Name", value: candidate.name || "N/A" },
      { label: "Email", value: candidate.email || "N/A" },
      { label: "Position", value: candidate.job_title || "N/A" },
    ];

    candidateInfo.forEach((item) => {
      doc.fontSize(10).fillColor("#6b7280").text(item.label + ":", 50, currentY);
      doc.fontSize(10).fillColor("#1f2937").text(item.value, 130, currentY);
      currentY += 18;
    });

    currentY += 15;
  }

  // ==================== CHATROOM INFO ====================
  doc.fontSize(14).fillColor(primaryRgb).text("CONVERSATION", 50, currentY);

  currentY += 5;
  doc
    .moveTo(50, currentY + 15)
    .lineTo(200, currentY + 15)
    .strokeColor("#d1d5db")
    .lineWidth(1)
    .stroke();

  currentY += 25;

  // Chatroom name and date range
  doc
    .fontSize(10)
    .fillColor("#6b7280")
    .text(`Chatroom: ${chatroom?.display_name || "Unknown"}`, 50, currentY);
  currentY += 16;
  doc
    .fontSize(10)
    .fillColor("#6b7280")
    .text(`Total Messages: ${messages.length}`, 50, currentY);
  currentY += 25;

  // ==================== MESSAGES ====================
  if (messages.length === 0) {
    doc
      .fontSize(11)
      .fillColor("#9ca3af")
      .text("No messages in the selected date range.", 50, currentY);
    currentY += 30;
  } else {
    for (const msg of messages) {
      // Check if we need a new page
      if (currentY > 680) {
        doc.addPage();
        currentY = 50;
      }

      // Message header (author + timestamp)
      let headerText = "";
      if (includeAuthors && msg.author_name) {
        headerText += msg.author_name;
      }
      if (includeTimestamps && msg.created_at) {
        const dateStr = new Date(msg.created_at).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        headerText += headerText ? ` - ${dateStr}` : dateStr;
      }

      if (headerText) {
        doc
          .fontSize(9)
          .fillColor(primaryRgb)
          .text(headerText, 50, currentY, { width: 512 });
        currentY += 14;
      }

      // Message content
      let content = msg.content || "";

      // Process @note mentions if needed
      if (!includeNoteMentions) {
        content = content.replace(/@note:\d+/g, "[note reference]");
      }

      // Draw message box
      const contentHeight = doc.heightOfString(content, {
        width: 492,
        fontSize: 10,
      });

      // Background box
      doc
        .rect(50, currentY - 2, 512, contentHeight + 12)
        .fill("#f9fafb");

      // Left border accent
      doc
        .rect(50, currentY - 2, 3, contentHeight + 12)
        .fill(msg.is_system ? "#9ca3af" : primaryRgb);

      // Message text
      doc
        .fontSize(10)
        .fillColor("#374151")
        .text(content, 60, currentY + 4, {
          width: 492,
          lineGap: 2,
        });

      currentY = doc.y + 15;
    }
  }

  // ==================== FOOTER ====================
  const pageCount = doc.bufferedPageRange().count;

  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);

    // Footer line
    doc
      .moveTo(50, 730)
      .lineTo(562, 730)
      .strokeColor("#d1d5db")
      .lineWidth(0.5)
      .stroke();

    // Footer text
    doc
      .fontSize(8)
      .fillColor("#9ca3af")
      .text(`Generated: ${new Date().toLocaleDateString()}`, 50, 738, {
        continued: true,
      })
      .text(` | Page ${i + 1} of ${pageCount}`, { continued: true })
      .text(" | CONFIDENTIAL", { align: "right" });
  }

  // Finalize PDF
  doc.end();

  // Wait for PDF to finish and return buffer
  return new Promise((resolve, reject) => {
    doc.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on("error", reject);
  });
}

module.exports = {
  generateCandidateProfilePDF,
  generateChatroomTranscriptPDF,
  fetchImageBuffer,
};
