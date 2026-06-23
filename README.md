# SERVICIOS INTEGRALES - Calculadora interna de cupo

Proyecto listo para subir a GitHub y desplegar en Vercel.

## Archivos principales

- `index.html`: pantalla interna para cargar el PDF y ver el cupo final.
- `api/process-receipt.js`: API de Vercel que lee el PDF y calcula el cupo.
- `package.json`: dependencias necesarias.
- `vercel.json`: configuración para Vercel.

## Cómo subirlo

1. Crear un repositorio nuevo en GitHub.
2. Subir todos estos archivos.
3. Entrar a Vercel.
4. Importar el repositorio desde GitHub.
5. Deploy.

## Cómo funciona

El sistema calcula:

Resultado X = Hab. c/Ap. - IPS - IOMA

Base 75% = Resultado X x 0.75

Cupo final = Base 75% - todos los descuentos que estén debajo de IOMA

## Importante

Solo funciona con PDF original con texto seleccionable.
No funciona con fotos, capturas ni escaneos convertidos a PDF.

## Prueba

Una vez desplegado, entrar al link de Vercel, cargar un recibo PDF original y tocar "Calcular cupo".
