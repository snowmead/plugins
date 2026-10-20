/** One JSON line per event, for the log pipeline. */
export const log = {
  info(scope: string, fields: Record<string, unknown>) {
    console.log(JSON.stringify({ level: 'info', scope, ...fields, at: new Date().toISOString() }));
  },
};
