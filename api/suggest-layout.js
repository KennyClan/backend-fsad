const ROOM_RULES = {
  "bedroom":
    "Bed on the dominant wall facing away from the door, nightstands flanking both sides of the bed, wardrobe near the entrance, lamp in corners, and 0.9m walkway clearance on all sides of every piece.",
  "living room":
    "Sofa facing the focal wall where the TV is, coffee table 0.4m in front of the sofa, rug under the coffee table area, lamp in corners, shelves against side walls.",
  "dining room":
    "Dining table centered in the room, chairs evenly spaced around all sides of the table, sideboard against the longest wall.",
  "home office":
    "Desk facing a wall or window for natural light, monitor centered on the desk, office chair behind the desk, shelves on a side wall, and 0.9m clearance behind the chair.",
  "kitchen":
    "Cabinets and cupboards flush against all walls, dining table if present centered in the remaining open space.",
  "wheelchair friendly":
    "ALL pathways minimum 1.2m wide, 1.5m circular turning radius kept clear in the room center, all furniture pushed against walls with no exceptions, no rugs or obstacles anywhere, bed accessible from both sides with 1.0m clearance on each side, door clearance 1.2m minimum.",
  "elderly friendly":
    "Clear straight pathways 0.9m minimum, no low furniture below 0.4m, seating near the entrance, bed at 0.5m height from the floor, no sharp corners in pathways, lamp near every seating and sleeping area.",
  "studio apartment":
    "Divide the room into three zones: sleep zone against one wall, work/desk zone near the window, lounge zone in the center-front, and maintain 0.9m pathways between zones.",
};

const SIZES = {
  bed_s: [0.9, 2.0],
  bed_d: [1.5, 2.0],
  bed_k: [1.8, 2.0],
  sofa_2: [1.6, 0.9],
  sofa_3: [2.0, 0.9],
  chair: [0.6, 0.6],
  armchair: [0.8, 0.8],
  coffee: [1.0, 0.5],
  table_rect: [1.2, 0.8],
  table_round: [1.0, 1.0],
  desk: [1.2, 0.6],
  cabinet: [0.6, 0.55],
  wall_cab: [0.9, 0.4],
  wardrobe: [1.5, 0.6],
  nightstand: [0.5, 0.45],
  tv: [1.4, 0.4],
  shelf: [0.8, 0.35],
  plant: [0.4, 0.4],
  rug: [1.6, 2.0],
  toilet: [0.7, 0.7],
  sink: [0.8, 0.6],
  bathtub: [1.7, 0.8],
  door: [0.9, 0.1],
  window: [1.2, 0.1],
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL_ID = "claude-haiku-4-5";
const MAX_TOKENS = 1000;
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_RULE =
  "Place furniture sensibly with 0.9m clearance and keep items within the room boundaries.";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function ruleFor(roomType) {
  const key = String(roomType || "").trim().toLowerCase();
  return ROOM_RULES[key] || DEFAULT_RULE;
}

function sizeFor(furnitureId) {
  const w = Number(furnitureId);
  return SIZES[furnitureId] || [0.8, 0.8];
}

function buildPrompt(body) {
  const { roomType, roomWidth, roomLength, furniture = [], roomStyle = "" } = body;
  const width = Number(roomWidth) || 4;
  const length = Number(roomLength) || 4;

  const roomRule = ruleFor(roomType);
  const lines = [
    `You are a room layout designer. Place every requested piece of furniture inside a ${width}m x ${length}m room.`,
    "",
    `Room type: ${roomType || "unknown"}`,
    `Room style: ${roomStyle || "not specified"}`,
    "",
    `Room type rules that you MUST follow above all else (the room style only informs aesthetics/placement rationale, never overrides these rules):`,
    roomRule,
    "",
    "Furniture to place:",
  ];

  furniture.forEach((f) => {
    const size = sizeFor(f.furnitureId);
    lines.push(`- ${f.furnitureId} (${f.label || f.furnitureId}), approximately ${size[0]}m x ${size[1]}m`);
  });

  lines.push(
    "",
    "Return ONLY a JSON array with one object per piece of furniture, no markdown, no explanation, no backticks:",
    '[{"furnitureId":"bed_d","x":0.5,"y":0.5,"rotation":0},{"furnitureId":"cabinet","x":3.0,"y":0.2,"rotation":90}]',
    "",
    "Rules for the JSON:",
    "- Include exactly one entry for every piece of furniture listed above.",
    "- x and y are the top-left corner position in meters from the room's top-left corner (0,0 = top-left).",
    "- rotation is 0, 90, 180, or 270 degrees only.",
    "- All items must stay fully within the room boundaries (no negative coordinates, item width + x must not exceed the room width, item length + y must not exceed the room length).",
    "- Account for the approximate furniture sizes listed above when placing items so they fit and keep required clearances.",
  );

  return lines.join("\n");
}

function stripFences(text) {
  const cleaned = String(text || "").trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : cleaned.replace(/^```(?:json)?\s*/, "").replace(/```$/, "");
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    return candidate.slice(start, end + 1);
  }
  return candidate;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
    return;
  }

  let body;
  try {
    body = JSON.parse(req.body || "{}");
  } catch (err) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  const { roomType, roomWidth, roomLength, furniture = [], roomStyle = "" } = body;
  if (!roomType) {
    res.status(400).json({ error: "roomType is required" });
    return;
  }
  if (!Array.isArray(furniture) || furniture.length === 0) {
    res.status(400).json({ error: "furniture must be a non-empty array" });
    return;
  }

  const prompt = buildPrompt(body);

  let anthropicResponse;
  try {
    anthropicResponse = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_ID,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Anthropic API request failed" });
    return;
  }

  if (!anthropicResponse.ok) {
    let detail = `Anthropic API returned ${anthropicResponse.status}`;
    try {
      const errBody = await anthropicResponse.json();
      if (errBody.error && errBody.error.message) detail += `: ${errBody.error.message}`;
    } catch (_) {
      /* ignore body parse errors */
    }
    res.status(500).json({ error: detail });
    return;
  }

  let text;
  try {
    const data = await anthropicResponse.json();
    text = data.content && data.content[0] && data.content[0].text ? data.content[0].text : "";
  } catch (err) {
    res.status(500).json({ error: "Failed to read Anthropic response: " + err.message });
    return;
  }

  let suggestions;
  try {
    suggestions = JSON.parse(stripFences(text));
  } catch (err) {
    res.status(500).json({ error: "Failed to parse", raw: text });
    return;
  }

  if (!Array.isArray(suggestions)) {
    res.status(500).json({ error: "Failed to parse", raw: text });
    return;
  }

  res.status(200).json({ suggestions });
}