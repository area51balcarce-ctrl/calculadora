import formidable from 'formidable';
import fs from 'fs';
import pdfParse from 'pdf-parse';

export const config = {
  api: {
    bodyParser: false
  }
};

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function parseArMoney(value) {
  if (!value) return 0;

  let s = String(value)
    .replace(/\$/g, '')
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '');

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (hasComma && hasDot) {
    // Argentina: 1.663.428,07
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    // Argentina sin miles: 1663428,07
    s = s.replace(',', '.');
  } else if (hasDot) {
    const parts = s.split('.');
    // Si tiene varios puntos, asumimos miles y último grupo como decimales solo si tiene 2 dígitos.
    if (parts.length > 2) {
      const last = parts.pop();
      s = parts.join('') + '.' + last;
    }
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

const MONEY_REGEX = /-?\$?\s*\d{1,3}(?:\.\d{3})*,\d{2}|-?\$?\s*\d+(?:,\d{2})|-?\$?\s*\d{1,3}(?:\.\d{3})+\.\d{2}|-?\$?\s*\d+\.\d{2}/g;

function moneyCandidates(line) {
  const matches = String(line).match(MONEY_REGEX) || [];
  return matches.map(parseArMoney).filter(n => Number.isFinite(n));
}

function lastMoney(line) {
  const values = moneyCandidates(line);
  return values.length ? values[values.length - 1] : 0;
}

function firstMoney(line) {
  const values = moneyCandidates(line);
  return values.length ? values[0] : 0;
}

function cleanLine(line) {
  return String(line || '').replace(/\s+/g, ' ').trim();
}

function isStopLine(line) {
  return /(neto\s+a\s+cobrar|neto|liquido|líquido|total\s+haberes|total\s+descuentos|totales|firma|recibi|recibí|son\s+pesos|banco|cuenta|cbu|legajo|fecha\s+de\s+pago|periodo|período|lugar\s+de\s+pago|observaciones)/i.test(line);
}

function findHaberes(text, lines) {
  // Buscar total o columna final de Hab. c/Ap.
  const patterns = [
    /hab\.?\s*c\/ap/i,
    /haberes?\s*c\/ap/i,
    /haberes?\s*con\s*aporte/i,
    /total\s+haberes?\s+con\s+aporte/i
  ];

  for (const pattern of patterns) {
    for (const line of lines) {
      if (pattern.test(line)) {
        const value = lastMoney(line);
        if (value > 0) return value;
      }
    }
  }

  // Fallback por contexto en texto completo.
  const match = text.match(/(?:hab\.?\s*c\/ap\.?|haberes?\s*con\s*aporte).{0,120}?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+\.\d{2})/i);
  return match ? parseArMoney(match[1]) : 0;
}

function findLineIndex(lines, regex) {
  return lines.findIndex(line => regex.test(line));
}

function findAmountByRegex(lines, regex) {
  for (const line of lines) {
    if (regex.test(line)) {
      const value = lastMoney(line);
      if (value > 0) return value;
    }
  }
  return 0;
}

function extractIoma(lines) {
  const index = findLineIndex(lines, /i\.?\s*o\.?\s*m\.?\s*a|ioma/i);
  if (index < 0) return { index: -1, amount: 0 };

  const valueSameLine = lastMoney(lines[index]);
  if (valueSameLine > 0) {
    return { index, amount: valueSameLine };
  }

  // Si el importe quedó en la línea siguiente por extracción rara.
  for (let i = index + 1; i <= Math.min(index + 2, lines.length - 1); i++) {
    const value = lastMoney(lines[i]);
    if (value > 0) return { index, amount: value };
  }

  return { index, amount: 0 };
}

function extractConceptAmount(line) {
  const values = moneyCandidates(line);
  if (!values.length) return null;

  // En recibos de sueldo el importe a descontar suele estar al final de la línea.
  const amount = values[values.length - 1];

  const concept = cleanLine(
    String(line)
      .replace(MONEY_REGEX, '')
      .replace(/\s+/g, ' ')
      .trim()
  );

  if (!concept) return null;
  if (amount <= 0) return null;

  return { concept, amount, raw: line };
}

function shouldIgnoreDiscountConcept(concept) {
  return /(hab\.?\s*c\/ap|haberes?|i\.?\s*p\.?\s*s|ips|i\.?\s*o\.?\s*m\.?\s*a|ioma|neto|liquido|líquido|total|totales|aporte\s+patronal|basico|básico|sueldo|remuneraci[oó]n)/i.test(concept);
}

/**
 * Regla de negocio:
 * Después de encontrar IOMA, se suma TODO concepto con importe que aparezca debajo de IOMA,
 * hasta llegar a una línea de corte como neto, totales, banco, firma, etc.
 *
 * No se usa lista fija porque cada recibo puede traer STM, Sindicato, AMFETAP,
 * Creditan, cuota alimentaria u otros descuentos.
 */
function extractDiscountsBelowIoma(lines, iomaIndex) {
  if (iomaIndex < 0) return [];

  const discounts = [];

  for (let i = iomaIndex + 1; i < lines.length; i++) {
    const line = cleanLine(lines[i]);
    if (!line) continue;

    // Cortes duros. Si aparece neto/totales/firma/etc, deja de sumar.
    if (isStopLine(line)) break;

    const item = extractConceptAmount(line);
    if (!item) continue;

    if (shouldIgnoreDiscountConcept(item.concept)) continue;

    // Evitar capturar importes absurdos si el parser leyó un bloque completo raro.
    if (item.amount > 0) {
      discounts.push(item);
    }
  }

  return discounts;
}

function calculateFromText(rawText) {
  const text = normalizeText(rawText);
  const lines = text.split('\n').map(cleanLine).filter(Boolean);

  const haberes = round2(findHaberes(text, lines));

  // IPS siempre se resta antes del 75%.
  const ips = round2(findAmountByRegex(lines, /i\.?\s*p\.?\s*s|ips\s*14|jubilaci[oó]n|aporte\s*jubilatorio/i));

  // IOMA siempre se resta antes del 75%.
  const iomaData = extractIoma(lines);
  const ioma = round2(iomaData.amount);

  // Todo descuento debajo de IOMA se resta después del 75%.
  const discounts = extractDiscountsBelowIoma(lines, iomaData.index);
  const totalDescuentos = round2(discounts.reduce((acc, item) => acc + item.amount, 0));

  const resultadoX = round2(haberes - ips - ioma);
  const base75 = round2(resultadoX * 0.75);
  const cupoFinal = round2(base75 - totalDescuentos);

  const manualReview = !haberes || !ips || !ioma || iomaData.index < 0;

  return {
    success: true,
    message: manualReview
      ? 'El recibo fue leído parcialmente. Requiere revisión manual antes de confirmar el cupo.'
      : 'Cupo calculado correctamente.',
    manual_review: manualReview,
    cupo_final: cupoFinal,
    debug: {
      formula: '((Hab. c/Ap. - IPS - IOMA) * 0.75) - descuentos debajo de IOMA',
      resumen: {
        haberes,
        ips,
        ioma,
        resultado_x: resultadoX,
        base_75: base75,
        total_descuentos: totalDescuentos
      },
      descuentos_debajo_ioma: discounts,
      ioma_line_index: iomaData.index,
      lineas_usadas: lines.slice(Math.max(0, iomaData.index - 4), Math.min(lines.length, iomaData.index + 18)),
      texto_extraido_preview: text.slice(0, 3500)
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

    const filePath = file.filepath || file.path;
    const originalName = file.originalFilename || file.name || '';

    if (!originalName.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({
        success: false,
        message: 'Solo se aceptan archivos PDF.'
      });
    }

    const buffer = fs.readFileSync(filePath);
    const parsed = await pdfParse(buffer);
    const text = parsed.text || '';

    if (!text.trim()) {
      return res.status(422).json({
        success: false,
        message: 'El PDF no tiene texto seleccionable. Usá el PDF original, no una foto o escaneo.'
      });
    }

    const result = calculateFromText(text);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error al procesar el PDF.',
      error: error.message
    });
  }
}
