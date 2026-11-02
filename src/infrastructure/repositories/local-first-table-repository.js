// The "tableRepository" port: a restaurant's tables and their sessions (guests seated until their bill is paid), kept on
// this device first (the state store + its storage), then queued for upload: a table is one row (hangtag_tables), a
// session one row (hangtag_table_sessions). The orders of a table are ordinary orders (orderRepository, kind "table").
// Dependencies come from app/container.js.

/* store: the state store · persist: { saveTables, saveTableSessions } · outbox: { enqueue } */
export function createLocalFirstTableRepository({ store, persist, outbox }){
  const tables = () => store.tables || (store.tables = {});
  const sessions = () => store.tableSessions || (store.tableSessions = {});
  return {
    tables: () => Object.values(tables()),
    table: id => tables()[id] || null,
    saveTable(t){ tables()[t.id] = t; persist.saveTables(); outbox.enqueue({ type: "table", id: t.id, table: t }); return t; },
    sessions: () => Object.values(sessions()),
    session: id => sessions()[id] || null,
    saveSession(s){ sessions()[s.id] = s; persist.saveTableSessions(); outbox.enqueue({ type: "tsession", id: s.id, session: s }); return s; },
  };
}
