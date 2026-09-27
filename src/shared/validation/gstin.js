// GST number check (format only): 15 letters and digits, like 27ABCDE1234F1Z5.
export const validGstin=g=>/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/.test(g);
