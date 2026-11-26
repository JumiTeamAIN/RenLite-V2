export const hasInvalidFaqText=(s:string)=>/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/u.test(s);
export interface FaqDraft {
  question: string;
  answer: string;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

export function parseUploadedFaqs(content: string, fileName: string): FaqDraft[] {
  const lowerName = fileName.toLowerCase();
  if(!/\.(json|csv|txt)$/.test(lowerName))throw Error('Unsupported file type. Use JSON, CSV or TXT.');
  if(hasInvalidFaqText(content))throw Error('File contains binary or invalid text.');
  content=content.replace(/^\uFEFF/,'');

  if (lowerName.endsWith('.json')) {
    const parsed = JSON.parse(content);
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.faqs) ? parsed.faqs : [];
    return items
      .map((item: any) => ({
        question: typeof (item?.question ?? item?.q)==='string'?(item.question??item.q).trim():'',
        answer: typeof (item?.answer ?? item?.a)==='string'?(item.answer??item.a).trim():'',
      }))
      .filter((f: FaqDraft) => f.question && f.answer);
  }

  if (lowerName.endsWith('.csv')) {
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    const rows = lines.map(parseCsvLine);
    const startIdx =
      rows.length > 0 &&
      rows[0][0]?.toLowerCase().includes('question') &&
      rows[0][1]?.toLowerCase().includes('answer')
        ? 1
        : 0;
    return rows
      .slice(startIdx)
      .map((cols) => ({
        question: (cols[0] || '').trim(),
        answer: (cols[1] || '').trim(),
      }))
      .filter((f) => f.question && f.answer);
  }

  const qaMatches: FaqDraft[] = [];
  const blockRegex = /Q:\s*([\s\S]*?)\nA:\s*([\s\S]*?)(?=\nQ:|\s*$)/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(content)) !== null) {
    const question = match[1].trim();
    const answer = match[2].trim();
    if (question && answer) {
      qaMatches.push({ question, answer });
    }
  }
  if (qaMatches.length > 0) return qaMatches;

  return content
    .split(/\r?\n/)
    .map((line) => line.split(/\s*\|\s*|\t/))
    .map((parts) => ({
      question: (parts[0] || '').trim(),
      answer: parts.slice(1).join(' ').trim(),
    }))
    .filter((f) => f.question && f.answer);
}

