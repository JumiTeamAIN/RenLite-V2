import type { HotelLocation, Request } from '../types.ts';

export interface DeterministicSafetySignal {
  triggered: boolean;
  severity: 'none' | 'high' | 'critical';
  category: string;
  department: string;
  item: string;
  reason: string;
}

const CRITICAL_PATTERNS: { regex: RegExp; item: string; reason: string }[] = [
  {
    regex: /\b(fire|flames|smoke|smoking|burning smell|incendio|fuego|humo|feu|fum[ée]e)\b/i,
    item: 'Fire or smoke emergency reported',
    reason: 'Guest reported potential fire or smoke hazard',
  },
  {
    regex: /\b(gas leak|smell gas|fuga de gas|olor a gas|carbon monoxide)\b/i,
    item: 'Gas or carbon monoxide hazard reported',
    reason: 'Guest reported potential gas leak or hazardous fumes',
  },
  {
    regex: /\b(medical emergency|heart attack|not breathing|can'?t breathe|unconscious|bleeding badly|call 911|emergencia m[ée]dica|ambulance)\b/i,
    item: 'Medical emergency reported',
    reason: 'Guest reported an urgent medical emergency',
  },
  {
    regex: /\b(intruder|breaking in|someone broke in|weapon|gun|knife|threat|threats|attack|assault|intruso|amenaza|arma)\b/i,
    item: 'Immediate security threat reported',
    reason: 'Guest reported a physical safety or security threat',
  },
];

const HIGH_PRIORITY_PATTERNS: {
  regex: RegExp;
  category: string;
  department: string;
  item: string;
  reason: string;
}[] = [
  {
    regex: /\b(bed\s?bugs?|chinches?|punaises?\s+de\s+lit)\b/i,
    category: 'Guest Recovery',
    department: 'Management',
    item: 'Suspected bedbugs reported',
    reason: 'Guest reported suspected bedbugs requiring immediate management recovery',
  },
  {
    regex: /\b(discriminat|racis|harass|acoso|discriminaci[óo]n)\b/i,
    category: 'Guest Recovery',
    department: 'Management',
    item: 'Guest discrimination or harassment complaint',
    reason: 'Guest reported discrimination or harassment requiring management review',
  },
  {
    regex: /\b(flooding|flooded|toilet overflowing|water pouring|sewage|inundaci[óo]n)\b/i,
    category: 'Maintenance',
    department: 'Engineering',
    item: 'Urgent water leak or flooding',
    reason: 'Guest reported active flooding or major plumbing failure',
  },
  {
    regex: /\b(speak (to|with) (a )?manager|talk to management|want a manager|hablar con el gerente)\b/i,
    category: 'Guest Recovery',
    department: 'Management',
    item: 'Management assistance requested',
    reason: 'Guest requested direct contact with hotel management',
  },
];

export function detectDeterministicSafetySignal(text: string): DeterministicSafetySignal {
  const input = text.trim();
  if (!input) {
    return {
      triggered: false,
      severity: 'none',
      category: 'General',
      department: 'Front Desk',
      item: '',
      reason: '',
    };
  }

  for (const rule of CRITICAL_PATTERNS) {
    if (rule.regex.test(input)) {
      return {
        triggered: true,
        severity: 'critical',
        category: 'Emergency',
        department: 'Security',
        item: rule.item,
        reason: rule.reason,
      };
    }
  }

  for (const rule of HIGH_PRIORITY_PATTERNS) {
    if (rule.regex.test(input)) {
      return {
        triggered: true,
        severity: 'high',
        category: rule.category,
        department: rule.department,
        item: rule.item,
        reason: rule.reason,
      };
    }
  }

  return {
    triggered: false,
    severity: 'none',
    category: 'General',
    department: 'Front Desk',
    item: '',
    reason: '',
  };
}

const LOCAL_INFO_REGEX =
  /\b(things to do|what to do|what'?s there to do|around here|in the area|nearby|near here|local|recommend(ation|ations)?|suggest(ion|ions)?|happy hours?|date night|cocktails?|steakhouse(s)?|seafood|romantic|places to eat|eat out|cafés?|dining|restaurant(s)?|where to eat|food|dinner|lunch|brunch|cafe|coffee shop|bakery|pizza|burger(s)?|taco(s)?|sushi|bar(s)?|pub|brewery|ice cream|attraction(s)?|activit(y|ies)|entertainment|kids|teens|family|park(s)?|beach(es)?|museum(s)?|arcade|movie(s)?|cinema|theater|mall|shopping|nightlife|golf|zoo|aquarium|pharmacy|grocery|supermarket|urgent care|weather|forecast|airport|shuttle|directions|qu[ée] hacer|cerca|restaurante(s)?|comer|cenar|lugares|actividades|recomendar|atracciones|hora feliz|copas|bares|restaurantes|recomendaciones|sortir|restaurants?|où manger|bonnes adresses|heure de l.apéritif|onde comer|passeios|recomendações)\b/i;

const FOLLOWUP_LOCAL_REGEX =
  /\b(what about|how about|any other|more options|something else|anything else|and for|y para|qu[ée] tal|otros|otras)\b/i;

export function needsLocalSearchGrounding(latestGuestMessage: string, transcript: string): boolean {
  const latest = (latestGuestMessage || '').trim();
  if (!latest) return false;
  if (LOCAL_INFO_REGEX.test(latest) || /餐厅|附近|推荐|レストラン|おすすめ|近く|맛집|근처|추천|مطاعم|بالقرب|おすすめ/.test(latest)) return true;

  if (FOLLOWUP_LOCAL_REGEX.test(latest)) {
    const recentLines = transcript.split('\n').slice(-6).join('\n');
    if (LOCAL_INFO_REGEX.test(recentLines)) {
      return true;
    }
  }
  return false;
}

export function extractAreaHint(persona: string, faqs: { question: string; answer: string }[]): string {
  const combined = `${persona || ''}\n${faqs.map((f) => `${f.question} ${f.answer}`).join('\n')}`;
  const zipMatch = combined.match(/\b\d{5}(?:-\d{4})?\b/);
  if (zipMatch) {
    return `US zip code ${zipMatch[0]}`;
  }
  const cityStateMatch = combined.match(/\b([A-Z][a-zA-Z.\s]{2,25},\s*[A-Z]{2})\b/);
  if (cityStateMatch) {
    return cityStateMatch[1];
  }
  return '';
}

export function resolveDepartment(category: string, item?: string): string {
  const cat = (category || '').toLowerCase();
  const title = (item || '').toLowerCase();

  if (
    cat.includes('emergency') ||
    cat.includes('security') ||
    title.includes('noise') ||
    title.includes('lock') ||
    title.includes('intruder')
  ) {
    return 'Security';
  }
  if (
    cat.includes('recovery') ||
    cat.includes('complaint') ||
    cat.includes('management') ||
    title.includes('bedbug') ||
    title.includes('bed bug')
  ) {
    return 'Management';
  }
  if (
    cat.includes('maintenance') ||
    cat.includes('engineering') ||
    title.includes('ac') ||
    title.includes('air conditioning') ||
    title.includes('plumbing') ||
    title.includes('toilet') ||
    title.includes('leak') ||
    title.includes('tv') ||
    title.includes('wifi') ||
    title.includes('wi-fi')
  ) {
    return 'Engineering';
  }
  if (
    cat.includes('housekeeping') ||
    cat.includes('room request') ||
    title.includes('towel') ||
    title.includes('pillow') ||
    title.includes('blanket') ||
    title.includes('clean') ||
    title.includes('linen') ||
    title.includes('iron') ||
    title.includes('plancha') ||
    title.includes('toalla') ||
    title.includes('trash') ||
    title.includes('toiletries')
  ) {
    return 'Housekeeping';
  }
  if (
    cat.includes('dining') ||
    cat.includes('room service') ||
    cat.includes('food') ||
    title.includes('breakfast') ||
    title.includes('dinner') ||
    title.includes('water') ||
    title.includes('coffee')
  ) {
    return 'Food & Beverage';
  }
  return 'Front Desk';
}

export function generateRequestRef(): string {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `R-${num}`;
}

export function normalizeLocationMatch(
  rawInput: string,
  locations: HotelLocation[] | undefined
): HotelLocation | null {
  if (!rawInput || !Array.isArray(locations) || locations.length === 0) return null;
  const cleaned = rawInput.trim().toLowerCase().replace(/^room\s+/i, '');
  return (
    locations.find(
      (loc) =>
        loc.active !== false &&
        (loc.id.toLowerCase() === rawInput.trim().toLowerCase() ||
          loc.code.toLowerCase() === cleaned ||
          loc.label.toLowerCase() === rawInput.trim().toLowerCase())
    ) || null
  );
}

const STOPWORDS = new Set([
  'extra',
  'more',
  'fresh',
  'additional',
  'please',
  'need',
  'want',
  'room',
  'deliver',
  'request',
  'issue',
  'problem',
  'the',
  'a',
  'an',
  'for',
  'my',
]);

function extractItemKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function findMatchingOpenRequest(
  existingRequests: Request[],
  candidate: { item: string; category: string }
): Request | null {
  const openStatuses = new Set(['pending', 'acknowledged', 'in_progress', 'escalated', 'reopened']);
  const open = existingRequests.filter((r) => openStatuses.has(r.status));
  if (open.length === 0) return null;

  const targetNorm = candidate.item.trim().toLowerCase();
  const targetKeywords = extractItemKeywords(targetNorm);

  for (const req of open) {
    const reqNorm = (req.item || '').trim().toLowerCase();
    if (reqNorm === targetNorm) return req;

    const reqKeywords = extractItemKeywords(reqNorm);
    if (
      targetKeywords.length > 0 &&
      reqKeywords.length > 0 &&
      targetKeywords.some((kw) => reqKeywords.includes(kw)) &&
      (req.category || '').toLowerCase() === (candidate.category || '').toLowerCase()
    ) {
      return req;
    }
  }

  return null;
}

export interface QuickRequestTemplate {
  id: string;
  item: string;
  category: string;
  department: string;
  priority: 'normal' | 'high';
  supportsQuantity: boolean;
  defaultQuantity: number;
  description: string;
}

export const QUICK_REQUEST_TEMPLATES: QuickRequestTemplate[] = [
  {
    id: 'towels',
    item: 'Fresh bath towels',
    category: 'Housekeeping',
    department: 'Housekeeping',
    priority: 'normal',
    supportsQuantity: true,
    defaultQuantity: 2,
    description: 'Deliver fresh bath towels',
  },
  {
    id: 'pillows',
    item: 'Additional pillows',
    category: 'Housekeeping',
    department: 'Housekeeping',
    priority: 'normal',
    supportsQuantity: true,
    defaultQuantity: 2,
    description: 'Deliver additional pillows',
  },
  {
    id: 'water',
    item: 'Bottled water',
    category: 'Housekeeping',
    department: 'Housekeeping',
    priority: 'normal',
    supportsQuantity: true,
    defaultQuantity: 2,
    description: 'Deliver bottled water',
  },
  {
    id: 'cleaning',
    item: 'Room cleaning service',
    category: 'Housekeeping',
    department: 'Housekeeping',
    priority: 'normal',
    supportsQuantity: false,
    defaultQuantity: 1,
    description: 'Guest requested housekeeping room cleaning',
  },
  {
    id: 'ac',
    item: 'Air conditioning check',
    category: 'Maintenance',
    department: 'Engineering',
    priority: 'high',
    supportsQuantity: false,
    defaultQuantity: 1,
    description: 'Inspect and service room air conditioning',
  },
  {
    id: 'plumbing',
    item: 'Plumbing repair',
    category: 'Maintenance',
    department: 'Engineering',
    priority: 'high',
    supportsQuantity: false,
    defaultQuantity: 1,
    description: 'Inspect and repair plumbing issue',
  },
  {
    id: 'late_checkout',
    item: 'Late checkout inquiry',
    category: 'Front Desk',
    department: 'Front Desk',
    priority: 'normal',
    supportsQuantity: false,
    defaultQuantity: 1,
    description: 'Guest inquired about late checkout availability',
  },
  {
    id: 'iron',
    item: 'Iron and ironing board',
    category: 'Housekeeping',
    department: 'Housekeeping',
    priority: 'normal',
    supportsQuantity: false,
    defaultQuantity: 1,
    description: 'Deliver iron and ironing board',
  },
];
