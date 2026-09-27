// Logger: where technical details go (the browser console), never shown to people.
// One place to change how the app logs; output is the same as the console calls it replaced.
export const logger = {
  error: (...args) => console.error(...args),
  warn: (...args) => console.warn(...args),
  info: (...args) => console.info(...args),
};
