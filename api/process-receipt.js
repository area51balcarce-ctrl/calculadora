import formidable from 'formidable';
import fs from 'fs';
import pdfParse from 'pdf-parse';

export const config = {
  api: {
    bodyParser: false
  }
};

const VERSION = 'formula-exacta-v5';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function cleanLine(line) {
  return String(line || '').replace(/\s+/g, ' ').trim();
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/*
  Lee importes completos:
  2209997.65
  2.209.997,65
  2,209,997.65
  898,382.79
  898.382,79
*/
const MONEY_REGEX = /-?\$?\s*\d[\d.,]*[.,]\d{2}/g;

function parseMoney(raw) {
  if (!raw) return 0;

  let s = String(raw)
    .replace(/\$/g, '')
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '');

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // 2.209.997,65
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // 2,209,997.65
      s = s.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    // 2209997,65
    s = s.replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function moneyValues(line) {
  const text = String(line || '');
  const values = [];

  for (const match of text.matchAll(MONEY_REGEX)) {
    const raw = match[0];
    const start = match.index || 0;
    const end = start + raw.length;

    // Evita capturar pedazos dentro de números largos.
    const before = text[start - 1] || '';
    const after = text[end] || '';
    if (/[\d.,]/.test(before) || /[\d.,]/.test(after)) continue;

    const value = parseMoney(raw);
    if (Number.isFinite(value)) values.push(value);
  }

  return values;
}

function isOnlyMoney(line) {
  return /^-?\$?\s*\d[\d.,]*[.,]\d{2}$/.test(cleanLine(line));
}

function lastMoney(line) {
  const values = moneyValues(line);
  return values.length ? values[values.length - 1] : 0;
}

function findLineIndex(lines, regex) {
  return lines.findIndex(line => regex.test(line));
}

function amountNearLine(lines, index, minAmount = 100) {
  if (index < 0) return 0;

  for (let i = index; i <= Math.min(index + 4, lines.length - 1); i++) {
    const values = moneyValues(lines[i]).filter(value => value >= minAmount);
    if (values.length) return round2(values[values.length - 1]);
  }

  return 0;
}

/*
  Busca fila de totales aunque el PDF la extraiga en una sola línea:
  2209997.65 1202135.41 2095517.06

  O aunque la extraiga en 3 líneas consecutivas:
  2209997.65
  1202135.41
  2095517.06
*/
function findTotalsRow(lines) {
  let best = null;

  // Caso 1: los 3 totales en una misma línea.
  for (const line of lines) {
    const values = moneyValues(line);
    if (values.length >= 3) {
      const [haberesConAporte, haberesSinAporte, totalDescuentos] = values.slice(-3);

      if (haberesConAporte > 100000 && totalDescuentos > 10000) {
        best = {
          haberesConAporte: round2(haberesConAporte),
          haberesSinAporte: round2(haberesSinAporte),
          totalDescuentos: round2(totalDescuentos),
          raw: line
        };
      }
    }
  }

  // Caso 2: los 3 totales en 3 líneas consecutivas.
  for (let i = 0; i <= lines.length - 3; i++) {
    if (!isOnlyMoney(lines[i]) || !isOnlyMoney(lines[i + 1]) || !isOnlyMoney(lines[i + 2])) continue;

    const haberesConAporte = moneyValues(lines[i])[0];
    const haberesSinAporte = moneyValues(lines[i + 1])[0];
    const totalDescuentos = moneyValues(lines[i + 2])[0];

    if (haberesConAporte > 100000 && totalDescuentos > 10000) {
      best = {
        haberesConAporte: round2(haberesConAporte),
        haberesSinAporte: round2(haberesSinAporte),
        totalDescuentos: round2(totalDescuentos),
        raw: `${lines[i]} | ${lines[i + 1]} | ${lines[i + 2]}`
      };
    }
  }

  return best;
}

function findHaberesConAporte(lines) {
  const totals = findTotalsRow(lines);
  if (totals && totals.haberesConAporte > 0) return totals.haberesConAporte;

  const ipsIndex = findLineIndex(lines, /i\.?\s*p\.?\s*s|ips\s*14/i);

  if (ipsIndex > 0) {
    let sum = 0;

    for (let i = 0; i < ipsIndex; i++) {
      const line = lines[i];

      // Solo conceptos que van a Hab. c/Ap. según este formato de recibo.
      if (/sueldo|basico|básico|jornada|antig[uü]edad|refrigerio|horario/i.test(line)) {
        const amount = amountNearLine(lines, i, 100);
        if (amount > 0) sum += amount;
      }
    }

    if (sum > 0) return round2(sum);
  }

  return 0;
}

function extractIoma(lines) {
  const index = findLineIndex(lines, /i\.?\s*o\.?\s*m\.?\s*a|ioma/i);
  return {
    index,
    amount: round2(amountNearLine(lines, index, 100))
  };
}

function extractIps(lines) {
  const index = findLineIndex(lines, /i\.?\s*p\.?\s*s|ips\s*14/i);
  return round2(amountNearLine(lines, index, 100));
}

function stopLine(line) {
  return /(son\s+pesos|liquido\s+a\s+pagar|líquido\s+a\s+pagar|neto\s+a\s+cobrar|neto|liquido|líquido|firma|recibi|recibí|banco|cuenta|cbu)/i.test(line);
}

function conceptItem(line) {
  const values = moneyValues(line);
  if (!values.length) return null;

  const amount = round2(values[values.length - 1]);
  const concept = cleanLine(String(line).replace(MONEY_REGEX, '').trim());

  if (!concept || amount <= 0) return null;
  return { concept, amount, raw: line };
}

function ignoreConcept(concept) {
  return /(hab\.?\s*c\/ap|haberes?|i\.?\s*p\.?\s*s|ips|i\.?\s*o\.?\s*m\.?\s*a|ioma|neto|liquido|líquido|total|totales|son\s+pesos)/i.test(concept);
}

function discountsBelowIomaByLines(lines, iomaIndex) {
  if (iomaIndex < 0) return [];

  const out = [];

  for (let i = iomaIndex + 1; i < lines.length; i++) {
    const line = cleanLine(lines[i]);
    if (!line) continue;
    if (stopLine(line)) break;

    const item = conceptItem(line);
    if (!item) continue;
    if (ignoreConcept(item.concept)) continue;

    out.push(item);
  }

  return out;
}

function calculateFromText(rawText) {
  const text = normalizeText(rawText);
  const lines = text.split('\n').map(cleanLine).filter(Boolean);

  const totalsRow = findTotalsRow(lines);

  const haberes = round2(findHaberesConAporte(lines));
  const ips = round2(extractIps(lines));
  const iomaData = extractIoma(lines);
  const ioma = round2(iomaData.amount);

  const byLineDiscounts = discountsBelowIomaByLines(lines, iomaData.index);
  const totalByLines = round2(byLineDiscounts.reduce((acc, item) => acc + item.amount, 0));

  let descuentosDebajoIoma = totalByLines;
  let fuenteDescuentos = 'lineas_debajo_ioma';

  /*
    Regla blindada para recibos con fila de totales:
    Descuentos debajo de IOMA = total columna Desc. - IPS - IOMA
  */
  if (totalsRow && totalsRow.totalDescuentos > 0 && ips > 0 && ioma > 0) {
    const calculated = round2(totalsRow.totalDescuentos - ips - ioma);
    if (calculated >= 0) {
      descuentosDebajoIoma = calculated;
      fuenteDescuentos = 'total_descuentos_recibo_menos_ips_ioma';
    }
  }

  const resultadoX = round2(haberes - ips - ioma);
  const base75 = round2(resultadoX * 0.75);
  const cupoFinal = round2(base75 - descuentosDebajoIoma);

  const manualReview = !haberes || !ips || !ioma || !totalsRow;

  return {
    success: true,
    version: VERSION,
    message: manualReview
      ? 'El recibo fue leído parcialmente. Requiere revisión manual antes de confirmar el cupo.'
      : 'Cupo calculado correctamente.',
    manual_review: manualReview,
    cupo_final: cupoFinal,
    debug: {
      version: VERSION,
      formula: '((Hab. c/Ap. - IPS - IOMA) * 0.75) - (Total descuentos recibo - IPS - IOMA)',
      fuente_descuentos: fuenteDescuentos,
      totals_row: totalsRow,
      resumen: {
        haberes,
        ips,
        ioma,
        resultado_x: resultadoX,
        base_75: base75,
        total_descuentos: descuentosDebajoIoma,
        total_descuentos_recibo: totalsRow ? totalsRow.totalDescuentos : 0
      },
      descuentos_detectados_por_linea: byLineDiscounts,
      lineas_cercanas_ioma: lines.slice(Math.max(0, iomaData.index - 4), Math.min(lines.length, iomaData.index + 18))
    }
  };
}

async function parseForm(req) {
  const form = formidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 15 * 1024 * 1024
  });

  return await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Método no permitido.'
    });
  }

  try {
    const { files } = await parseForm(req);
    const uploaded = files.recibo_pdf;
    const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'No se recibió ningún PDF.'
      });
    }

    const name = file.originalFilename || file.name || '';

    if (!name.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({
        success: false,
        message: 'Solo se aceptan archivos PDF.'
      });
    }

    const buffer = fs.readFileSync(file.filepath || file.path);
    const parsed = await pdfParse(buffer);
    const text = parsed.text || '';

    if (!String(text).trim()) {
      return res.status(422).json({
        success: false,
        message: 'El PDF no tiene texto seleccionable. Usá el PDF original, no una foto o escaneo.'
      });
    }

    return res.status(200).json(calculateFromText(text));
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error al procesar el PDF.',
      error: error.message
    });
  }
}
