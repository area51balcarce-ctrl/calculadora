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
    // Formato argentino: 1.234.567,89
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    // 1234567,89
    s = s.replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function moneyCandidates(line) {
  const matches = String(line).match(/-?\$?\s*\d{1,3}(?:\.\d{3})*,\d{2}|-?\$?\s*\d+(?:,\d{2})|-?\$?\s*\d{1,3}(?:\.\d{3})+\.\d{2}|-?\$?\s*\d+\.\d{2}/g) || [];
  return matches.map(parseArMoney).filter(n => Number.isFinite(n));
}

function lastMoney(line) {
  const values = moneyCandidates(line);
  return values.length ? values[values.length - 1] : 0;
}

function findHaberes(text, lines) {
  // Prioridad: líneas que contengan el total Hab. c/Ap.
  for (const line of lines) {
    if (/hab\.?\s*c\/ap/i.test(line) || /haberes?\s*con\s*aporte/i.test(line)) {
      const value = lastMoney(line);
      if (value > 0) return value;
    }
  }

  // Fallback: buscar cerca de la palabra Hab. c/Ap. en todo el texto
  const match = text.match(/hab\.?\s*c\/ap\.?.{0,80}?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+\.\d{2})/i);
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

function extractConceptAmount(line) {
  const value = lastMoney(line);
  if (!value) return null;

  const concept = String(line)
    .replace(/-?\$?\s*\d{1,3}(?:\.\d{3})*,\d{2}|-?\$?\s*\d+(?:,\d{2})|-?\$?\s*\d{1,3}(?:\.\d{3})+\.\d{2}|-?\$?\s*\d+\.\d{2}/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!concept) return null;
  return { concept, amount: value, raw: line };
}

function extractDiscountsBelowIoma(lines, iomaIndex) {
  if (iomaIndex < 0) return [];

  const discounts = [];
  const stopRegex = /(totales?|neto|liquido|líquido|firma|recibi|recib[ií]|son pesos|banco|cuenta|cbu|legajo|fecha|periodo|per[ií]odo)/i;

  for (let i = iomaIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Cortar cuando empiezan bloques que no son descuentos
    if (stopRegex.test(line) && moneyCandidates(line).length <= 1) {
      break;
    }

    const item = extractConceptAmount(line);
    if (!item) continue;

    // Evita capturar totales finales como si fueran descuentos
    if (/total|neto|liquido|líquido|hab\.?\s*c\/ap|ips|ioma/i.test(item.concept)) {
      continue;
    }

    // Solo valores razonables
    if (item.amount > 0) {
      discounts.push(item);
    }
  }

  return discounts;
}

function calculateFromText(rawText) {
  const text = normalizeText(rawText);
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);

  const haberes = round2(findHaberes(text, lines));
  const ips = round2(findAmountByRegex(lines, /i\.?\s*p\.?\s*s|ips\s*14|jubilaci[oó]n|aporte\s*jubilatorio/i));
  const iomaIndex = findLineIndex(lines, /i\.?\s*o\.?\s*m\.?\s*a|ioma/i);
  const ioma = round2(iomaIndex >= 0 ? lastMoney(lines[iomaIndex]) : 0);

  const discounts = extractDiscountsBelowIoma(lines, iomaIndex);
  const totalDescuentos = round2(discounts.reduce((acc, item) => acc + item.amount, 0));

  const resultadoX = round2(haberes - ips - ioma);
  const base75 = round2(resultadoX * 0.75);
  const cupoFinal = round2(base75 - totalDescuentos);

  const manualReview = !haberes || !ips || !ioma || iomaIndex < 0;

  return {
    success: true,
    message: manualReview
      ? 'El recibo fue leído parcialmente. Requiere revisión manual antes de confirmar el cupo.'
      : 'Cupo calculado correctamente.',
    manual_review: manualReview,
    cupo_final: cupoFinal,
    debug: {
      resumen: {
        haberes,
        ips,
        ioma,
        resultado_x: resultadoX,
        base_75: base75,
        total_descuentos: totalDescuentos
      },
      descuentos_debajo_ioma: discounts,
      texto_extraido_preview: text.slice(0, 2500)
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
