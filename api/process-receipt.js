import formidable from 'formidable';
import fs from 'fs';
import pdfParse from 'pdf-parse';

export const config = { api: { bodyParser: false } };

const VERSION = 'pdf-robusto-v7';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function clean(line) {
  return String(line || '').replace(/\s+/g, ' ').trim();
}

function normalize(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

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
      // 2,209,997.65 / 898,382.79
      s = s.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    s = s.replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function moneyValues(text) {
  const src = String(text || '');
  const out = [];

  for (const match of src.matchAll(MONEY_REGEX)) {
    const raw = match[0];
    const start = match.index || 0;
    const end = start + raw.length;

    const before = src[start - 1] || '';
    const after = src[end] || '';

    // Evita capturar pedazos dentro de números largos.
    if (/[\d.,]/.test(before) || /[\d.,]/.test(after)) continue;

    const value = parseMoney(raw);
    if (Number.isFinite(value)) out.push(value);
  }

  return out;
}

function lastMoney(line) {
  const values = moneyValues(line);
  return values.length ? values[values.length - 1] : 0;
}

function findLineIndex(lines, regex) {
  return lines.findIndex(line => regex.test(line));
}

function amountOnOrNearLine(lines, index) {
  if (index < 0) return 0;

  for (let i = index; i <= Math.min(index + 2, lines.length - 1); i++) {
    const values = moneyValues(lines[i]).filter(v => v > 0);
    if (values.length) return round2(values[values.length - 1]);
  }

  return 0;
}

/**
 * Busca la fila final de totales.
 * En estos recibos la lógica es:
 * ... Total Hab. c/Ap. | Total Hab. s/Ap. | Total Desc.
 * antes del bloque "Son Pesos".
 */
function findTotalsFromBeforeSonPesos(text) {
  const sonIndex = text.search(/son\s+pesos/i);
  const part = sonIndex >= 0 ? text.slice(0, sonIndex) : text;
  const values = moneyValues(part).filter(v => v > 0);

  if (values.length >= 3) {
    const [haberesConAporte, haberesSinAporte, totalDescuentos] = values.slice(-3);

    if (haberesConAporte > 100000 && totalDescuentos > 10000) {
      return {
        haberesConAporte: round2(haberesConAporte),
        haberesSinAporte: round2(haberesSinAporte),
        totalDescuentos: round2(totalDescuentos),
        source: 'ultimos_3_importes_antes_de_son_pesos'
      };
    }
  }

  return null;
}

/**
 * Fallback para Hab. c/Ap.:
 * suma líneas antes de IPS con código menor a 60000.
 * En recibos municipales/hospital, esos códigos suelen ser remunerativos con aporte:
 * 10000, 12000, 12510, 12512, 12600, 12800, etc.
 *
 * Excluye 61000/62000/62010 porque suelen estar en Hab. s/Ap.
 */
function sumHaberesConAportePorCodigo(lines) {
  const ipsIndex = findLineIndex(lines, /i\.?\s*p\.?\s*s|ips\s*14/i);
  if (ipsIndex <= 0) return 0;

  let total = 0;

  for (let i = 0; i < ipsIndex; i++) {
    const line = lines[i];

    const codeMatch = line.match(/\b(\d{5})\b/);
    if (!codeMatch) continue;

    const code = Number(codeMatch[1]);

    if (code >= 10000 && code < 60000) {
      const amount = lastMoney(line);
      if (amount > 0) total += amount;
    }
  }

  return round2(total);
}

function extractIps(lines) {
  const index = findLineIndex(lines, /i\.?\s*p\.?\s*s|ips\s*14/i);
  return round2(amountOnOrNearLine(lines, index));
}

function extractIoma(lines) {
  const index = findLineIndex(lines, /i\.?\s*o\.?\s*m\.?\s*a|ioma/i);
  return {
    index,
    amount: round2(amountOnOrNearLine(lines, index))
  };
}

function stopDiscountLine(line) {
  return /(son\s+pesos|liquido\s+a\s+pagar|líquido\s+a\s+pagar|neto\s+a\s+cobrar|neto|liquido|líquido|firma|recibi|recibí|banco|cuenta|cbu)/i.test(line);
}

function ignoreDiscountConcept(line) {
  return /(i\.?\s*p\.?\s*s|ips|i\.?\s*o\.?\s*m\.?\s*a|ioma|total|totales|neto|liquido|líquido|son\s+pesos)/i.test(line);
}

function discountsBelowIomaByLines(lines, iomaIndex) {
  if (iomaIndex < 0) return [];

  const out = [];

  for (let i = iomaIndex + 1; i < lines.length; i++) {
    const line = clean(lines[i]);
    if (!line) continue;
    if (stopDiscountLine(line)) break;
    if (ignoreDiscountConcept(line)) continue;

    const amount = lastMoney(line);
    if (amount > 0) out.push({ concept: line.replace(MONEY_REGEX, '').trim(), amount: round2(amount), raw: line });
  }

  return out;
}

function calculateFromText(rawText) {
  const text = normalize(rawText);
  const lines = text.split('\n').map(clean).filter(Boolean);

  const totals = findTotalsFromBeforeSonPesos(text);
  const haberesPorCodigo = sumHaberesConAportePorCodigo(lines);

  let haberes = totals?.haberesConAporte || 0;

  // Si la fila de totales no apareció o salió sospechosa, usar suma por código.
  if (!haberes || haberes < 500000) {
    haberes = haberesPorCodigo;
  }

  // Si ambos existen y son razonables, preferir el total del recibo.
  if (totals?.haberesConAporte > 500000) {
    haberes = totals.haberesConAporte;
  }

  const ips = extractIps(lines);
  const iomaData = extractIoma(lines);
  const ioma = iomaData.amount;

  const descuentosLineas = discountsBelowIomaByLines(lines, iomaData.index);
  const descuentosPorLinea = round2(descuentosLineas.reduce((acc, item) => acc + item.amount, 0));

  let totalDescuentosRecibo = totals?.totalDescuentos || 0;
  let descuentosDebajoIoma = descuentosPorLinea;
  let fuenteDescuentos = 'lineas_debajo_ioma';

  // Regla exacta cuando está el total de descuentos del recibo.
  if (totalDescuentosRecibo > 0 && ips > 0 && ioma > 0) {
    descuentosDebajoIoma = round2(totalDescuentosRecibo - ips - ioma);
    fuenteDescuentos = 'total_descuentos_recibo_menos_ips_ioma';
  }

  const resultadoX = round2(haberes - ips - ioma);
  const base75 = round2(resultadoX * 0.75);
  const cupoFinal = round2(base75 - descuentosDebajoIoma);

  const manualReview = !haberes || !ips || !ioma || !descuentosDebajoIoma;

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
      formula: '((Hab. c/Ap. - IPS - IOMA) * 0.75) - descuentos debajo de IOMA',
      fuente_haberes: totals?.haberesConAporte ? 'total_recibo' : 'suma_codigos_menores_60000',
      fuente_descuentos: fuenteDescuentos,
      totals_row: totals,
      resumen: {
        haberes: round2(haberes),
        haberes_por_codigo: haberesPorCodigo,
        ips,
        ioma,
        resultado_x: resultadoX,
        base_75: base75,
        total_descuentos: descuentosDebajoIoma,
        total_descuentos_recibo: totalDescuentosRecibo
      },
      descuentos_detectados_por_linea: descuentosLineas,
      primeras_lineas: lines.slice(0, 40),
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
