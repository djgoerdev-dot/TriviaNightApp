import ExcelJS from 'exceljs';

/**
 * Parses a host's question spreadsheet into rows the importer can act on.
 *
 * The expected columns are category / question / answer / points, but hosts
 * build these files by hand, so header matching is deliberately forgiving:
 * case, surrounding space, punctuation and common synonyms all resolve to the
 * same field. Column ORDER does not matter — only the header names.
 */

export interface ParsedRow {
  rowNumber: number;
  category: string;
  question: string;
  answer: string;
  points: number | null;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Rows that could not be used, with the reason, so the host can fix the file. */
  problems: { rowNumber: number; reason: string }[];
  headers: string[];
}

interface InputRow {
  rowNumber: number;
  cells: unknown[];
}

const FIELD_SYNONYMS: Record<string, 'category' | 'question' | 'answer' | 'points'> = {
  category: 'category',
  categories: 'category',
  categoryname: 'category',
  round: 'category',
  rounds: 'category',
  roundname: 'category',
  section: 'category',
  sections: 'category',
  topic: 'category',
  topics: 'category',

  question: 'question',
  questions: 'question',
  prompt: 'question',
  prompts: 'question',
  q: 'question',
  questiontext: 'question',
  questionprompt: 'question',

  answer: 'answer',
  answers: 'answer',
  correctanswer: 'answer',
  correctanswers: 'answer',
  correct: 'answer',
  solution: 'answer',
  solutions: 'answer',
  a: 'answer',
  answertext: 'answer',

  points: 'points',
  point: 'points',
  allocatedpoints: 'points',
  allocatedpoint: 'points',
  pts: 'points',
  pt: 'points',
  score: 'points',
  scores: 'points',
  value: 'points',
  values: 'points',
  pointvalue: 'points',
  pointvalues: 'points',
  marks: 'points',
  mark: 'points'
};

function normalizeHeader(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[\s_\-().:#?]/g, '')
    .trim();
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';

  // ExcelJS hands back rich text, formula results and hyperlinks as objects.
  if (typeof value === 'object') {
    const v = value as any;
    if (Array.isArray(v.richText)) return v.richText.map((t: any) => t.text).join('').trim();
    if (v.text !== undefined && v.text !== null) return String(v.text).trim();
    if (v.result !== undefined && v.result !== null) {
      if (typeof v.result === 'object') {
        if (v.result instanceof Date) return v.result.toISOString().slice(0, 10);
        if (v.result.error) return '';
        if (Array.isArray(v.result.richText)) return v.result.richText.map((t: any) => t.text).join('').trim();
        return '';
      }
      return String(v.result).trim();
    }
    if (v.hyperlink !== undefined && v.hyperlink !== null) return String(v.hyperlink).trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(value).trim();
}

function parsePoints(value: unknown): number | null {
  const text = cellText(value);
  if (!text) return null;
  const stripped = text.replace(/[^0-9.\-]/g, '');
  if (!stripped || stripped === '-' || stripped === '.') return null;
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/** RFC-4180 CSV reader tracking 1-based line numbers. */
function parseCsv(text: string): InputRow[] {
  const rows: InputRow[] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let lineStart = 1;
  let currentLine = 1;

  // Strip a UTF-8 BOM, which Excel writes on "CSV UTF-8" export.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
        if (ch === '\n') currentLine++;
      }
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      if (row.some(c => c.trim() !== '')) {
        rows.push({ rowNumber: lineStart, cells: row });
      }
      row = [];
      field = '';
      currentLine++;
      lineStart = currentLine;
      continue;
    }
    field += ch;
  }

  row.push(field);
  if (row.some(c => c.trim() !== '')) {
    rows.push({ rowNumber: lineStart, cells: row });
  }

  return rows;
}

/** Maps normalized headers to their column index. */
function mapColumns(headerCells: unknown[]) {
  const map: Partial<Record<'category' | 'question' | 'answer' | 'points', number>> = {};
  const headers: string[] = [];

  headerCells.forEach((cell, idx) => {
    const text = cellText(cell);
    headers.push(text);
    const field = FIELD_SYNONYMS[normalizeHeader(cell)];
    if (field && map[field] === undefined) map[field] = idx;
  });

  return { map, headers };
}

function buildRows(table: InputRow[]): ParseResult {
  if (table.length === 0) {
    return { rows: [], problems: [{ rowNumber: 0, reason: 'The file is empty.' }], headers: [] };
  }

  const headerRow = table[0];
  const { map, headers } = mapColumns(headerRow.cells);
  const missing = (['category', 'question', 'answer'] as const).filter(f => map[f] === undefined);
  if (missing.length > 0) {
    return {
      rows: [],
      headers,
      problems: [{
        rowNumber: headerRow.rowNumber,
        reason:
          `The header row is missing: ${missing.join(', ')}. ` +
          `Expected columns named category, question, answer and points. Found: ${headers.filter(Boolean).join(', ') || '(none)'}.`
      }]
    };
  }

  const rows: ParsedRow[] = [];
  const problems: ParseResult['problems'] = [];
  let lastCategory = '';

  for (let i = 1; i < table.length; i++) {
    const item = table[i];
    const cells = item.cells || [];
    const rowNumber = item.rowNumber;

    let category = cellText(cells[map.category!]);
    const question = cellText(cells[map.question!]);
    const answer = cellText(cells[map.answer!]);
    const points = map.points !== undefined ? parsePoints(cells[map.points]) : null;

    if (!category && !question && !answer) continue; // blank spacer row

    // Inherit category from round header or vertically merged cell
    if (!category && lastCategory && (question || answer)) {
      category = lastCategory;
    } else if (category) {
      lastCategory = category;
    }

    const missingFields: string[] = [];
    if (!category) missingFields.push('category');
    if (!question) missingFields.push('question');
    if (!answer) missingFields.push('answer');

    if (missingFields.length > 0) {
      problems.push({ rowNumber, reason: `Missing ${missingFields.join(', ')}.` });
      continue;
    }

    if (points !== null && (points < 1 || points > 50)) {
      problems.push({ rowNumber, reason: `Points must be between 1 and 50 (found ${points}).` });
      continue;
    }

    rows.push({ rowNumber, category, question, answer, points });
  }

  return { rows, problems, headers };
}

export async function parseWorkbook(buffer: Buffer, filename: string): Promise<ParseResult> {
  const isCsv = /\.csv$/i.test(filename);

  if (isCsv) {
    const table = parseCsv(buffer.toString('utf-8'));
    let headerIndex = 0;
    for (let i = 0; i < Math.min(table.length, 10); i++) {
      const hit = table[i].cells.some(cell => FIELD_SYNONYMS[normalizeHeader(cell)] === 'question');
      if (hit) { headerIndex = i; break; }
    }
    return buildRows(table.slice(headerIndex));
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);

  let targetSheet = workbook.worksheets[0];
  if (!targetSheet) {
    return { rows: [], headers: [], problems: [{ rowNumber: 0, reason: 'The workbook has no sheets.' }] };
  }

  // If there are multiple sheets, pick the one that contains question columns
  for (const s of workbook.worksheets) {
    let found = false;
    s.eachRow({ includeEmpty: false }, (row) => {
      if (found) return;
      const vals = Array.isArray(row.values) ? (row.values as unknown[]).slice(1) : [];
      if (vals.some(cell => FIELD_SYNONYMS[normalizeHeader(cell)] === 'question')) {
        found = true;
      }
    });
    if (found) {
      targetSheet = s;
      break;
    }
  }

  const table: InputRow[] = [];
  targetSheet.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.isArray(row.values) ? (row.values as unknown[]).slice(1) : [];
    table.push({ rowNumber: row.number, cells: values });
  });

  // Find the header row: the first row that names at least a question column.
  let headerIndex = 0;
  for (let i = 0; i < Math.min(table.length, 10); i++) {
    const hit = table[i].cells.some(cell => FIELD_SYNONYMS[normalizeHeader(cell)] === 'question');
    if (hit) { headerIndex = i; break; }
  }

  return buildRows(table.slice(headerIndex));
}
