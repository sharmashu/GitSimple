import { GoogleGenAI } from "@google/genai";

const client = new GoogleGenAI({}); // Automatically picks up process.env.GEMINI_API_KEY

const maxDiffLength = 30000;

function truncateDiff(diff: string) {
  return diff.length > maxDiffLength ? diff.slice(0, maxDiffLength) + "\n\n... [DIFF TRUNCATED]" : diff;
}

export async function generateBriefSummary(diffText: string): Promise<string> {
  const truncatedDiff = truncateDiff(diffText);
  const prompt = `Here are some code changes (a git diff).\n<diff>\n${truncatedDiff}\n</diff>\n\nWrite a very short, concise summary of these changes, strictly in the style of a git commit message. Do not explain in detail. Just state what was done. Use a neat format: a 1-sentence summary, followed by a short bulleted list of the exact technical changes (e.g., added X, modified Y function).`;

  try {
    const interaction = await client.interactions.create({
      model: "gemini-3.5-flash",
      input: prompt,
      system_instruction: "You are a developer writing a clean, concise, technical git commit message. Use neat bullet points and formatting."
    });
    return interaction.output_text || "Could not generate brief summary.";
  } catch (error: any) {
    console.error("Gemini Error:", error);
    return "Error generating summary. Please check your Gemini API key.";
  }
}

export async function generateDetailedExplanation(diffText: string): Promise<string> {
  const truncatedDiff = truncateDiff(diffText);
  const prompt = `Here are some code changes (a git diff).\n<diff>\n${truncatedDiff}\n</diff>\n\nWrite a highly detailed technical breakdown of these changes formatted as a professional engineering report. \nUse clear, neat headings and bullet points with double line breaks for readability. \nInclude the following sections if present in the diff:\n- Architecture & Logic: Logical changes or refactoring\n- Functions & Interfaces: New functions, modified arguments, interfaces\n- Database & Schema: Schema modifications\n- Frontend & UI: Component changes, state management\nEnsure the format is extremely clean and easy to read.`;

  try {
    const interaction = await client.interactions.create({
      model: "gemini-3.5-flash",
      input: prompt,
      system_instruction: "You are an expert software architect providing comprehensive, neatly formatted, professional technical reports of codebase changes."
    });
    return interaction.output_text || "Could not generate detailed explanation.";
  } catch (error: any) {
    console.error("Gemini Error:", error);
    return "Error generating explanation. Please check your Gemini API key.";
  }
}

export async function chatWithCommit(diffText: string, userMessage: string, history: { role: string, content: string }[]): Promise<string> {
  const truncatedDiff = truncateDiff(diffText);

  const systemPrompt = `You are an expert technical assistant answering questions about this specific code change and the broader project.
Keep your answers precise and technical. Explain exactly what specific functions contribute to the project, interpret technical details in the commit, and provide clear, detailed technical answers even to vague questions.
Here is the context diff:\n\n${truncatedDiff}`;

  try {
    // Reconstruct the history as a string or use a multi-turn chat if needed.
    // For simplicity with this prompt, we can inject the history contextually.
    let fullInput = "";
    if (history.length > 0) {
      fullInput += "Previous Conversation:\n";
      history.forEach(h => {
        fullInput += `${h.role === 'user' ? 'User' : 'Oracle'}: ${h.content}\n`;
      });
      fullInput += `\nNew User Message: ${userMessage}`;
    } else {
      fullInput = userMessage;
    }

    const interaction = await client.interactions.create({
      model: "gemini-3.5-flash",
      input: fullInput,
      system_instruction: systemPrompt
    });

    return interaction.output_text || "I'm sorry, I couldn't answer that.";
  } catch (error: any) {
    console.error("Gemini Error:", error);
    return "Error communicating with Oracle. Please check your Gemini API key.";
  }
}

export async function generateStructuredCommitAnalysis(diffText: string): Promise<any> {
  const truncatedDiff = truncateDiff(diffText);
  const prompt = `Analyze this git diff and return a JSON object with exactly these fields:
{
  "executive_summary": "string: a concise high-level summary of what was done",
  "architectural_impact": "string: explanation of how this affects the system architecture, or 'None' if negligible",
  "breaking_changes": ["string"],
  "impact_level": "string (MUST BE exactly one of: Breaking, Feature, Refactor, Security, Performance, Fix)",
  "affected_domains": ["string"]
}

Return ONLY valid JSON.

Diff:
${truncatedDiff}`;

  try {
    const interaction = await client.interactions.create({
      model: "gemini-3.5-flash",
      input: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    return JSON.parse(interaction.output_text || "{}");
  } catch (error: any) {
    console.error("Gemini Error generating structured analysis:", error);
    return {
      executive_summary: "Failed to generate summary.",
      architectural_impact: "Unknown",
      breaking_changes: [],
      impact_level: "Fix",
      affected_domains: []
    };
  }
}

