import { type SqlJsStatic } from 'sql.js';

declare const initSqlJsFromLoader: (config?: { wasmBinary?: ArrayBuffer, locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;
export default initSqlJsFromLoader; 