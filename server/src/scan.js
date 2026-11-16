// Reading a photo of a cribbage hand: four cards and the cut card.
//
// The phone sends the photo here, this passes it to Claude and returns the
// cards it read. Nothing is stored or logged: the photo lives only for the
// length of the request. Scoring happens on the phone, not here.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const MAX_IMAGE = 2 * 1024 * 1024;   // base64 characters (about 1.5 MB of JPEG)
const TYPES = ["image/jpeg", "image/png", "image/webp"];

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["S", "H", "D", "C"];
export const CARDS = RANKS.flatMap((r) => SUITS.map((s) => r + s));

export const PROMPT = `This photo is from a game of cribbage. It should show five playing cards: a four-card hand (or crib) and the cut card (the starter), which is set apart from the other four — usually above, below or beside them, or turned a different way.

Read each card's rank and suit from its corner index and pips. Write each card as rank then suit: ranks A 2 3 4 5 6 7 8 9 10 J Q K, suits S (spades) H (hearts) D (diamonds) C (clubs). For example "10H", "QS", "AD".

Put the four hand cards in "hand" and the cut card in "cut". If you can't tell which card is the cut, use your best guess and say so in "note". If a card is hidden, blurred, cut off or you aren't sure of it, leave it out rather than guessing, and say which in "note". If there aren't five cards, list the ones you can read and say what's wrong in "note". Keep "note" to one short sentence, or an empty string when everything is clear.`;

const SCHEMA = {
  type: "object",
  properties: {
    hand: { type: "array", items: { type: "string", enum: CARDS } },
    cut: { type: "string", enum: [...CARDS, ""] },
    note: { type: "string" },
  },
  required: ["hand", "cut", "note"],
  additionalProperties: false,
};

// The JSON in a reply: the text after the last fallback switch (a fallback
// model's answer starts over), skipping thinking blocks.
function replyText(blocks) {
  let start = 0;
  blocks.forEach((b, i) => { if (b.type === "fallback") start = i + 1; });
  return blocks.slice(start).filter((b) => b.type === "text").map((b) => b.text).join("");
}

// Keep only well-formed, distinct cards
export function cleanReading(raw) {
  const seen = new Set();
  const ok = (c) => typeof c === "string" && CARDS.includes(c) && !seen.has(c) && seen.add(c);
  const cut = ok(raw && raw.cut) ? raw.cut : "";
  const hand = (Array.isArray(raw && raw.hand) ? raw.hand : []).filter(ok).slice(0, 4);
  const note = typeof (raw && raw.note) === "string" ? raw.note.slice(0, 200) : "";
  return { hand, cut, note };
}

export async function readHand(env, body) {
  const image = body && typeof body.image === "string" ? body.image : "";
  const type = body && TYPES.includes(body.type) ? body.type : "image/jpeg";
  if (!image || image.length > MAX_IMAGE || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return { status: 400, data: { error: "bad_image" } };
  }

  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),   // local testing only
    timeout: 60 * 1000,
    maxRetries: 1,
  });

  let resp;
  try {
    resp = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: type, data: image } },
          { type: "text", text: PROMPT },
        ],
      }],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return { status: 429, data: { error: "busy" } };
    if (err instanceof Anthropic.BadRequestError) return { status: 400, data: { error: "bad_image" } };
    if (err instanceof Anthropic.AuthenticationError) return { status: 503, data: { error: "scan_not_configured" } };
    return { status: 502, data: { error: "scan_failed" } };
  }

  if (resp.stop_reason === "refusal") return { status: 422, data: { error: "unreadable" } };
  try {
    return { status: 200, data: cleanReading(JSON.parse(replyText(resp.content))) };
  } catch {
    return { status: 502, data: { error: "scan_failed" } };
  }
}
