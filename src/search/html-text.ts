const CODE_ELEMENTS = new Set(["script", "style", "noscript", "svg", "template", "math"]);
const CHROME_ELEMENTS = new Set(["iframe", "form", "nav", "aside", "footer", "head", "button", "select", "picture", "figure"]);
const BLOCK_ELEMENTS = new Set([
  "p", "div", "section", "article", "main", "br", "hr", "li", "ul", "ol", "tr", "td", "th",
  "table", "blockquote", "pre", "figcaption", "dd", "dt", "address", "h1", "h2", "h3", "h4", "h5", "h6",
]);

const NAMED_ENTITY = /&(amp|lt|gt|quot|apos|nbsp|rsquo|lsquo|rdquo|ldquo|mdash|ndash|hellip|middot|deg|eacute|egrave|uuml|ouml|auml|szlig);/gi;
const NUMERIC_ENTITY = /&#(x[0-9a-f]+|\d+);/gi;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const SENTENCE_END = /[.!?]["')\]]?(?:\s|$)/;
const SENTENCE_SPLIT = /[.!?]["')\]]?(?=\s|$)/;
const LOWERCASE_START = /^[\p{Ll}]/u;
const CODE_ARTIFACT = /[{};]|":"|=>|@media\b/g;
const TAG_NAME = /[a-zA-Z][^\s/>]*/y;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–",
  hellip: "…", middot: "·", deg: "°", eacute: "é", egrave: "è",
  uuml: "ü", ouml: "ö", auml: "ä", szlig: "ß",
};

const MIN_PROSE_WORDS_PER_LINE = 8;
const MIN_SHORT_LINE_WORDS = 4;
const MIN_LOWERCASE_WORD_RATIO = 0.5;
const MIN_PROSE_CHARACTERS = 300;
const MAX_CODE_ARTIFACTS_PER_1000 = 6;
const SMALL_DOCUMENT_CHARACTERS = 2000;
const LARGE_DOCUMENT_CHARACTERS = 20000;

export interface ProseQuality {
  characters: number;
  sentences: number;
  codeArtifactsPer1000: number;
}

interface ParsedTag {
  name: string;
  closing: boolean;
  end: number;
}

function decodeEntities(text: string): string {
  return text
    .replace(NAMED_ENTITY, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(NUMERIC_ENTITY, (match, code: string) => {
      const point = code[0]?.toLowerCase() === "x" ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    });
}

function endOfTag(html: string, start: number): number {
  let index = start;
  while (index < html.length) {
    const character = html[index]!;
    if (character === ">") return index + 1;
    if (character === '"' || character === "'") {
      const closingQuote = html.indexOf(character, index + 1);
      index = closingQuote === -1 ? html.length : closingQuote + 1;
      continue;
    }
    index += 1;
  }
  return html.length;
}

function parseTag(html: string, position: number): ParsedTag | null {
  const closing = html[position + 1] === "/";
  TAG_NAME.lastIndex = position + (closing ? 2 : 1);
  const name = TAG_NAME.exec(html)?.[0];
  if (!name) return null;
  return { name: name.toLowerCase(), closing, end: endOfTag(html, TAG_NAME.lastIndex) };
}

function closingTagIndex(html: string, name: string, from: number): number {
  const marker = new RegExp(`<\\/${name}\\s*>`, "i");
  const match = marker.exec(html.slice(from));
  return match ? from + match.index + match[0].length : -1;
}

function skipComment(html: string, position: number): number {
  const end = html.indexOf("-->", position);
  return end === -1 ? html.length : end + 3;
}

function skipElement(html: string, tag: ParsedTag, dropUnterminated: boolean): number {
  const closed = closingTagIndex(html, tag.name, tag.end);
  if (closed !== -1) return closed;
  return dropUnterminated ? html.length : tag.end;
}

function consumeElement(html: string, tag: ParsedTag, pieces: string[]): number {
  if (!tag.closing && CODE_ELEMENTS.has(tag.name)) return skipElement(html, tag, true);
  if (!tag.closing && CHROME_ELEMENTS.has(tag.name)) return skipElement(html, tag, false);
  if (BLOCK_ELEMENTS.has(tag.name)) pieces.push("\n");
  return tag.end;
}

function consumeTag(html: string, position: number, pieces: string[]): number {
  if (html.startsWith("<!--", position)) return skipComment(html, position);
  const marker = html[position + 1];
  if (marker === "!" || marker === "?") return endOfTag(html, position + 1);
  const tag = parseTag(html, position);
  if (tag) return consumeElement(html, tag, pieces);
  pieces.push("<");
  return position + 1;
}

function textPieces(html: string): string[] {
  const pieces: string[] = [];
  let position = 0;
  while (position < html.length) {
    const nextTag = html.indexOf("<", position);
    if (nextTag === -1) {
      pieces.push(html.slice(position));
      break;
    }
    pieces.push(html.slice(position, nextTag), " ");
    position = consumeTag(html, nextTag, pieces);
  }
  return pieces;
}

function toLines(text: string): string[] {
  return decodeEntities(text)
    .split("\n")
    .map(line => line.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean);
}

function wordsOf(line: string): string[] {
  return line.match(WORD) ?? [];
}

function isProseLine(line: string): boolean {
  const words = wordsOf(line);
  const endsSentence = SENTENCE_END.test(line);
  if (words.length < MIN_SHORT_LINE_WORDS) return false;
  if (words.length < MIN_PROSE_WORDS_PER_LINE) return endsSentence;
  if (endsSentence) return true;
  const lowercase = words.filter(word => LOWERCASE_START.test(word)).length;
  return lowercase / words.length >= MIN_LOWERCASE_WORD_RATIO;
}

export function proseQuality(text: string): ProseQuality {
  const artifacts = text.match(CODE_ARTIFACT)?.length ?? 0;
  return {
    characters: text.length,
    sentences: text.split(SENTENCE_SPLIT).length - 1,
    codeArtifactsPer1000: text.length ? (artifacts * 1000) / text.length : 0,
  };
}

export function isReadableProse(text: string, documentCharacters = 0): boolean {
  const quality = proseQuality(text);
  if (!quality.characters) return false;
  if (quality.codeArtifactsPer1000 > MAX_CODE_ARTIFACTS_PER_1000) return false;
  return documentCharacters < LARGE_DOCUMENT_CHARACTERS || quality.characters >= MIN_PROSE_CHARACTERS;
}

export function htmlToText(html: string): string {
  const lines = toLines(textPieces(html).join(""));
  return html.length < SMALL_DOCUMENT_CHARACTERS ? lines.join("\n\n") : lines.filter(isProseLine).join("\n\n");
}

export function plainTextToProse(text: string): string {
  return toLines(text.replace(/\r\n?/g, "\n")).filter(isProseLine).join("\n\n");
}
