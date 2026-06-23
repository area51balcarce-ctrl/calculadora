import formidable from 'formidable';
import fs from 'fs';
import pdfParse from 'pdf-parse';

export const config = { api: { bodyParser: false } };

function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

function norm(t) {
  return String(t || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/*
  Captura importes completos, evitando tomar pedazos chicos dentro de números grandes.
  Soporta:
  - 2209997.65
  - 2.209.997,65
  - 2,209,997.65
  - 898,382.79
  - 898.382,79
*/
const MONEY = /(?<![\d.,])-?\$?\s*(?:\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d+[.,]\d{2})(?![\d.,])/g;

function parseMoney(v) {
  if (!v) return 0;

  let s = String(v)
    .replace(/\$/g, '')
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '');

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // AR: 2.209.997,65
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // US: 2,209,997.65
      s = s.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    s = s.replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function nums(line) {
  return (String(line).match(MONEY) || [])
    .map(parseMoney)
    .filter(Number.isFinite);
}

function lastMoney(line) {
  const n = nums(line);
  return n.length ? n[n.length - 1] : 0;
}

function clean(l) {
  return String(l || '').replace(/\s+/g, ' ').trim();
}

function findIdx(lines, rx) {
  return lines.findIndex(l => rx.test(l));
}

function findAmount(lines, rx) {
  for (const l of lines) {
    if (rx.test(l)) {
      const v = lastMoney(l);
      if (v > 0) return v;
    }
  }
  return 0;
}

function findTotalsRow(lines) {
  let best = null;

  for (const line of lines) {
    const n = nums(line);

    if (n.length >= 3) {
      const [habCAp, habSAp, totalDesc] = n.slice(-3);

      if (habCAp > 100000 && totalDesc > 10000) {
        best = {
          haberesConAporte: round2(habCAp),
          haberesSinAporte: round2(habSAp),
          totalDescuentos: round2(totalDesc),
          raw: line
        };
      }
    }
  }

  return best;
}

function findHaberes(lines) {
  const totals = findTotalsRow(lines);
  if (totals?.haberesConAporte > 0) return totals.haberesConAporte;

  const ipsIdx = findIdx(lines, /i\.?\s*p\.?\s*s|ips\s*14/i);
  if (ipsIdx > 0) {
    let sum = 0;

    for (let i = 0; i < ipsIdx; i++) {
      const l = lines[i];

      if (/sueldo|basico|básico|jornada|antig[uü]edad|refrigerio|horario|presentismo|horas|bonif|adicional|guardia/i.test(l)) {
        const v = lastMoney(l);
        if (v > 0) sum += v;
      }
    }

    if (sum > 0) return round2(sum);
  }

  for (const l of lines) {
    if (/hab\.?\s*c\/ap|haberes?\s*con\s*aporte/i.test(l)) {
      const v = lastMoney(l);
      if (v > 0) return v;
    }
  }

  return 0;
}

function extractIoma(lines) {
  const idx = findIdx(lines, /i\.?\s*o\.?\s*m\.?\s*a|ioma/i);
  if (idx < 0) return { index: -1, amount: 0 };

  const v = lastMoney(lines[idx]);
  if (v > 0) return { index: idx, amount: v };

  for (let i = idx + 1; i <= Math.min(idx + 2, lines.length - 1); i++) {
    const x = lastMoney(lines[i]);
    if (x > 0) return { index: idx, amount: x };
  }

  return { index: idx, amount: 0 };
}

function isStop(l) {
  return /(son\s+pesos|liquido\s+a\s+pagar|líquido\s+a\s+pagar|neto\s+a\s+cobrar|neto|liquido|líquido|firma|recibi|recibí|banco|cuenta|cbu)/i.test(l);
}

function conceptItem(line) {
  const n = nums(line);
  if (!n.length) return null;

  const amount = round2(n[n.length - 1]);
  const concept = clean(String(line).replace(MONEY, '').trim());

  if (!concept || amount <= 0) return null;
  return { concept, amount, raw: line };
}

function ignoreConcept(c) {
  return /(hab\.?\s*c\/ap|haberes?|i\.?\s*p\.?\s*s|ips|i\.?\s*o\.?\s*m\.?\s*a|ioma|neto|liquido|líquido|total|totales|son\s+pesos)/i.test(c);
}

function discountsByLines(lines, iomaIdx) {
  if (iomaIdx < 0) return [];

  const out = [];

  for (let i = iomaIdx + 1; i < lines.length; i++) {
    const l = clean(lines[i]);
    if (!l) continue;
    if (isStop(l)) break;

    const item = conceptItem(l);
    if (!item) continue;
    if (ignoreConcept(item.concept)) continue;

    out.push(item);
  }

  return out;
}

function calculate(raw) {
  const text = norm(raw);
  const lines = text.split('\n').map(clean).filter(Boolean);

  const totals = findTotalsRow(lines);

  const haberes = round2(findHaberes(lines));
  const ips = round2(findAmount(lines, /i\.?\s*p\.?\s*s|ips\s*14/i));
  const iomaData = extractIoma(lines);
  const ioma = round2(iomaData.amount);

  const lineDiscounts = discountsByLines(lines, iomaData.index);
  const totalByLines = round2(lineDiscounts.reduce((a, b) => a + b.amount, 0));

  let totalDebajoIoma = totalByLines;
  let fuente = 'lineas_debajo_ioma';

  // Fórmula blindada cuando existe fila de totales:
  // descuentos debajo de IOMA = total columna Desc. - IPS - IOMA
  if (totals?.totalDescuentos > 0 && ips > 0 && ioma > 0) {
    const calc = round2(totals.totalDescuentos - ips - ioma);
    if (calc >= 0) {
      totalDebajoIoma = calc;
      fuente = 'total_descuentos_menos_ips_ioma';
    }
  }

  const resultadoX = round2(haberes - ips - ioma);
  const base75 = round2(resultadoX * 0.75);
  const cupoFinal = round2(base75 - totalDebajoIoma);

  const manual = !haberes || !ips || !ioma;

  return {
    success: true,
    message: manual
      ? 'El recibo fue leído parcialmente. Requiere revisión manual antes de confirmar el cupo.'
      : 'Cupo calculado correctamente.',
    manual_review: manual,
    cupo_final: cupoFinal,
    debug: {
      formula: '((Hab. c/Ap. - IPS - IOMA) * 0.75) - descuentos debajo de IOMA',
      fuente_descuentos: fuente,
      totals_row: totals,
      resumen: {
        haberes,
        ips,
        ioma,
        resultado_x: resultadoX,
        base_75: base75,
        total_descuentos: totalDebajoIoma,
        total_descuentos_recibo: totals ? totals.totalDescuentos : 0
      },
      descuentos_detectados_por_linea: lineDiscounts,
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

    return res.status(200).json(calculate(text));
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: 'Error al procesar el PDF.',
      error: e.message
    });
  }
}
