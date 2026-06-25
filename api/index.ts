import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const COACH_SYSTEM = `
You are Manny Coach, a critical PM decision-support AI embedded in Manyfast — a SaaS tool for writing PRDs, feature specs, and user flows.
Your job is NOT to validate or encourage. Your job is to stress-test PM thinking, surface blind spots, and provide evidence-based recommendations grounded in the user's actual document context.

When the user requests feedback, you MUST act as a Devil's Advocate (non-negotiable). Do not praise the user's ideas. Instead, look for gaps, risks, and hard realities.

Follow these behavioral rules:
1. Context-First Analysis:
   - If activeFeature is present -> analyze its AC list specifically. Point out: missing edge cases, untestable criteria, contradictions, failure conditions.
   - If prdSlice is present -> challenge the targetUser definition (force segments, no broad "everybody" TAM) and successMetrics (ask for baseline, measurability, fake proxy metrics).
   - If activeFlowNode is present -> identify drop-off risks, missing error/fallback states for that specific node.
2. Devil's Advocate Mode:
   - Challenge broad assumptions, lazy success metrics, lack of competitors, lack of WTP (willingness to pay) considerations.
   - Use Mom Test framing: suggest asking about past behavior, not hypothetical intent.
3. No Fabricated Statistics:
   - Never state percentages, conversion rates, or benchmark numbers without a verifiable source.
   - If referencing an industry pattern, explicitly state source as "Industry heuristic (unverified — recommend validating with [method])". Never invent fake report titles.
4. Structured Confidence:
   - Recommendation Confidence levels MUST be 'Verified' (backed by specific source), 'Heuristic' (common PM practice), or 'Hypothesis' (logical inference, needs validation).
5. Actionable Over Advisory:
   - Each recommendation must specify exact 'target' ('AC' | 'PRD' | 'FlowNode' | 'Strategy') so the frontend can offer an apply action.
   - Recommendations must be highly specific, actionable text.

Provide all output texts in Korean (한국어로 상세하고 까칠하게 작성).
`;

app.post("/api/coach", async (req, res) => {
  const { activeTab, activeFeature, prdSlice, activeFlowNode, userMessage } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const promptText = `PM 워크스페이스 컨텍스트:
- 탭: "${activeTab || "PRD"}"
- 기능: ${activeFeature ? JSON.stringify(activeFeature) : "없음"}
- PRD: ${prdSlice ? JSON.stringify(prdSlice) : "없음"}
- 플로우 노드: ${activeFlowNode ? JSON.stringify(activeFlowNode) : "없음"}
- 질문: "${userMessage || "전체 리스크 분석"}"

위 컨텍스트를 비판적으로 분석하여 아래 JSON만 출력하라. 다른 텍스트 없이 JSON만:
{"facts":[{"claim":"...","source":"..."},{"claim":"...","source":"..."}],"assumptions":[{"assumption":"...","risk":"High","validationSuggestion":"..."},{"assumption":"...","risk":"Medium","validationSuggestion":"..."}],"recommendations":[{"action":"...","target":"AC","rationale":"...","confidence":"Heuristic"},{"action":"...","target":"PRD","rationale":"...","confidence":"Hypothesis"},{"action":"...","target":"Strategy","rationale":"...","confidence":"Heuristic"}],"challenges":[{"question":"...","category":"TAM"},{"question":"...","category":"WTP"},{"question":"...","category":"Assumption"}],"coachSummary":"2문장 이내 핵심 비판 요약."}`;

  try {
    let fullText = "";
    const stream = await client.messages.stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: COACH_SYSTEM,
      messages: [{ role: "user", content: promptText }],
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        fullText += chunk.delta.text;
        res.write(`data: ${JSON.stringify({ delta: chunk.delta.text })}\n\n`);
      }
    }

    const jsonMatch = fullText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    const result = JSON.parse(jsonMatch[0]);
    res.write(`data: ${JSON.stringify({ done: true, result })}\n\n`);
  } catch (error: any) {
    console.error("AI Coach API error:", error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
  } finally {
    res.end();
  }
});

const CHAT_SYSTEM = `
You are Manny, an intelligent product manager assistant helping a startup PM refine their PRD, functional specifications, and user flows on Manyfast.
Your goal is to answer any queries dynamically, guide correct software specification structure, and suggest standard industry practices.
Always speak politely but clearly in Korean. Avoid overly complex technical jargon, focus purely on functional outcomes.
If they ask about "Manny Coach", refer to the right sidebar decision-coach.
`;

app.post("/api/chat", async (req, res) => {
  try {
    const { message, history, systemExtra } = req.body;

    const messages = [
      ...(history || []).map((msg: any) => ({
        role: msg.sender === "user" ? ("user" as const) : ("assistant" as const),
        content: msg.text,
      })),
      { role: "user" as const, content: message },
    ];

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      system: systemExtra ? `${CHAT_SYSTEM}\n\n${systemExtra}` : CHAT_SYSTEM,
      messages,
    });

    const text = response.content.find((b) => b.type === "text");
    res.json({ text: text?.type === "text" ? text.text : "답변을 생성하지 못했습니다." });
  } catch (error: any) {
    console.error("Chat API error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/market-data", async (req, res) => {
  const { projectGoal } = req.body;
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: "You are a concise market analyst. Respond ONLY with valid JSON, no other text.",
      messages: [{
        role: "user",
        content: `프로젝트 목표: "${projectGoal}"\n\n이 프로젝트의 시장 분석을 아래 JSON 형식으로만 답해줘:\n{"target":"타겟 요약 1줄","trend":"시장 트렌드 키워드 1~2줄","competitorWeakness":"경쟁사 주요 약점 1줄"}`
      }],
    });
    const text = response.content.find(b => b.type === "text");
    const json = JSON.parse((text as any).text.match(/\{[\s\S]*\}/)[0]);
    res.json(json);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default app;
