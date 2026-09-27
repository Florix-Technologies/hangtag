# extract-bill (Supabase Edge Function)

Reads a supplier bill (text PDF, scanned PDF, or phone photo) and returns its product lines for the **Upload bill**
screen on the Stock page. Nothing is added to stock here: the app shows every line for review, and stock changes only
when the merchant confirms (`hangtag_import_stock` in `supabase/schema.sql`).

- `index.ts`: HTTP wrapper (Deno). Needs a signed-in user, checks the upload, picks the provider.
- `core.js`: request building, the JSON schema the answer must match, validation and normalisation (unit-tested in Node:
  `tests/unit/extract-bill.test.mjs`).
- `providers/claude.js`: Claude reads the PDF (as a document) or photo (as an image) and answers in JSON constrained to
  the schema (structured outputs), with adaptive thinking and streaming. A request Claude declines is re-run on
  Anthropic's recommended fallback model (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
- `providers/mock.js`: a fixed extraction for trying the flow without an API key.

To use another OCR or extraction service, add a provider with the same `extract({ data, mimeType, fileName })` →
`{ ok, result }` shape. The app doesn't change, because it only talks to this function.

## Deploy

```bash
supabase functions deploy extract-bill --project-ref <your-project-ref>
supabase secrets set ANTHROPIC_API_KEY=<your key> --project-ref <your-project-ref>
# optional
supabase secrets set EXTRACT_MODEL=claude-opus-5        # default
supabase secrets set EXTRACT_PROVIDER=mock              # test the flow without a key
```

Keep JWT verification on (the default): the app calls the function with the signed-in user's session.

## Limits and privacy

- PDF, JPG, PNG and WebP files up to 15 MB. The app shrinks photos to at most 2000 px before sending them.
- The bill is sent to Anthropic's API to be read, and is not stored by the function. The app keeps only the confirmed
  lines in `hangtag_stock_imports`.
- Uncertain values come back as `null` with a low `confidence`. The app marks such lines "Needs review".
