import assert from "node:assert/strict";
import test from "node:test";

import {
  extractSymbolsFromSource,
  getNodeSourceLocation,
  isSupportedSymbolFile,
} from "./extractor.ts";
import { readGoldenFixtureFileText } from "../fixtures/golden.ts";

test("1. function extraction extracts top-level function declarations with async and return type", () => {
  const code = `
export async function calculateTotal(amount: number, tax: number): Promise<number> {
  return amount + tax;
}

function privateHelper(x: string): string {
  return x.trim();
}
`;
  const result = extractSymbolsFromSource({
    relativePath: "src/billing.ts",
    sourceText: code,
  });

  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.symbols.length, 2);

  const calc = result.symbols.find((s) => s.name === "calculateTotal");
  assert.ok(calc);
  assert.equal(calc.kind, "function");
  assert.equal(calc.exported.isExported, true);
  assert.equal(calc.exported.isDefaultExport, false);
  assert.equal(calc.exported.exportName, "calculateTotal");
  assert.equal(calc.metadata?.isAsync, true);
  assert.equal(calc.metadata?.returnType, "Promise<number>");

  const helper = result.symbols.find((s) => s.name === "privateHelper");
  assert.ok(helper);
  assert.equal(helper.kind, "function");
  assert.equal(helper.exported.isExported, false);
  assert.equal(helper.exported.isDefaultExport, false);
  assert.equal(helper.metadata?.returnType, "string");
});

test("2. arrow-function variable extraction extracts const arrow functions as functions", () => {
  const code = `
export const formatCurrency = (val: number): string => {
  return "$" + val.toFixed(2);
};

const internalProcessor = async () => {};
`;
  const result = extractSymbolsFromSource({
    relativePath: "src/formatters.ts",
    sourceText: code,
  });

  assert.equal(result.symbols.length, 2);

  const fmt = result.symbols.find((s) => s.name === "formatCurrency");
  assert.ok(fmt);
  assert.equal(fmt.kind, "function");
  assert.equal(fmt.exported.isExported, true);
  assert.equal(fmt.metadata?.isConst, true);
  assert.equal(fmt.metadata?.returnType, "string");

  const proc = result.symbols.find((s) => s.name === "internalProcessor");
  assert.ok(proc);
  assert.equal(proc.kind, "function");
  assert.equal(proc.exported.isExported, false);
  assert.equal(proc.metadata?.isAsync, true);
});

test("3. class extraction extracts class declarations with abstract and exported metadata", () => {
  const code = `
export abstract class BaseService {
  abstract run(): void;
}

class InternalWorker {}
`;
  const result = extractSymbolsFromSource({
    relativePath: "src/services.ts",
    sourceText: code,
  });

  const base = result.symbols.find((s) => s.name === "BaseService");
  assert.ok(base);
  assert.equal(base.kind, "class");
  assert.equal(base.exported.isExported, true);
  assert.equal(base.metadata?.isAbstract, true);

  const worker = result.symbols.find((s) => s.name === "InternalWorker");
  assert.ok(worker);
  assert.equal(worker.kind, "class");
  assert.equal(worker.exported.isExported, false);
});

test("4. class method extraction extracts methods with accessibility, static, async, and parent hierarchy", () => {
  const code = `
export class OrderService {
  public static async createOrder(id: string): Promise<void> {}
  protected validate(): boolean { return true; }
  private calculateTax(): number { return 0; }
}
`;
  const result = extractSymbolsFromSource({
    relativePath: "src/order.ts",
    sourceText: code,
  });

  const classSym = result.symbols.find((s) => s.name === "OrderService" && s.kind === "class");
  assert.ok(classSym);

  const methods = result.symbols.filter((s) => s.kind === "method");
  assert.equal(methods.length, 3);

  const createOrder = methods.find((m) => m.name === "createOrder");
  assert.ok(createOrder);
  assert.equal(createOrder.parentSymbolId, classSym.id);
  assert.equal(createOrder.parentName, "OrderService");
  assert.equal(createOrder.metadata?.accessibility, "public");
  assert.equal(createOrder.metadata?.isStatic, true);
  assert.equal(createOrder.metadata?.isAsync, true);
  assert.equal(createOrder.metadata?.returnType, "Promise<void>");

  const validate = methods.find((m) => m.name === "validate");
  assert.ok(validate);
  assert.equal(validate.metadata?.accessibility, "protected");

  const calcTax = methods.find((m) => m.name === "calculateTax");
  assert.ok(calcTax);
  assert.equal(calcTax.metadata?.accessibility, "private");
});

test("5. interface extraction extracts interface declarations", () => {
  const code = `
export interface UserPayload {
  id: string;
  email: string;
}

interface LocalConfig {
  debug: boolean;
}
`;
  const result = extractSymbolsFromSource({
    relativePath: "src/user.ts",
    sourceText: code,
  });

  assert.equal(result.symbols.length, 2);

  const user = result.symbols.find((s) => s.name === "UserPayload");
  assert.ok(user);
  assert.equal(user.kind, "interface");
  assert.equal(user.exported.isExported, true);

  const config = result.symbols.find((s) => s.name === "LocalConfig");
  assert.ok(config);
  assert.equal(config.kind, "interface");
  assert.equal(config.exported.isExported, false);
});

test("6. type-alias extraction extracts type aliases", () => {
  const code = `
export type Result<T> = { data: T } | { error: string };
type Id = string | number;
`;
  const result = extractSymbolsFromSource({
    relativePath: "src/types.ts",
    sourceText: code,
  });

  assert.equal(result.symbols.length, 2);

  const res = result.symbols.find((s) => s.name === "Result");
  assert.ok(res);
  assert.equal(res.kind, "type_alias");
  assert.equal(res.exported.isExported, true);

  const id = result.symbols.find((s) => s.name === "Id");
  assert.ok(id);
  assert.equal(id.kind, "type_alias");
  assert.equal(id.exported.isExported, false);
});

test("7. enum extraction extracts regular and const enums", () => {
  const code = `
export enum OrderStatus {
  Pending = "PENDING",
  Completed = "COMPLETED"
}

const enum Priority {
  Low,
  High
}
`;
  const result = extractSymbolsFromSource({
    relativePath: "src/status.ts",
    sourceText: code,
  });

  assert.equal(result.symbols.length, 2);

  const order = result.symbols.find((s) => s.name === "OrderStatus");
  assert.ok(order);
  assert.equal(order.kind, "enum");
  assert.equal(order.exported.isExported, true);

  const prio = result.symbols.find((s) => s.name === "Priority");
  assert.ok(prio);
  assert.equal(prio.kind, "enum");
  assert.equal(prio.metadata?.isConst, true);
});

test("8. variable and constant extraction distinguishes const vs let/var and destructuring", () => {
  const code = `
export const MAX_RETRY_COUNT = 5;
let attemptCount: number = 0;
var debugFlag = false;
export const { port, host } = { port: 8080, host: "localhost" };
`;
  const result = extractSymbolsFromSource({
    relativePath: "src/config.ts",
    sourceText: code,
  });

  const maxRetry = result.symbols.find((s) => s.name === "MAX_RETRY_COUNT");
  assert.ok(maxRetry);
  assert.equal(maxRetry.kind, "constant");
  assert.equal(maxRetry.exported.isExported, true);
  assert.equal(maxRetry.metadata?.isConst, true);

  const attempt = result.symbols.find((s) => s.name === "attemptCount");
  assert.ok(attempt);
  assert.equal(attempt.kind, "variable");
  assert.equal(attempt.exported.isExported, false);
  assert.equal(attempt.metadata?.isConst, false);
  assert.equal(attempt.metadata?.typeAnnotation, "number");

  const debug = result.symbols.find((s) => s.name === "debugFlag");
  assert.ok(debug);
  assert.equal(debug.kind, "variable");

  const port = result.symbols.find((s) => s.name === "port");
  assert.ok(port);
  assert.equal(port.kind, "constant");
  assert.equal(port.exported.isExported, true);

  const host = result.symbols.find((s) => s.name === "host");
  assert.ok(host);
  assert.equal(host.kind, "constant");
  assert.equal(host.exported.isExported, true);
});

test("9. exported declarations and export clause matching recognize separate export statements", () => {
  const code = `
function workerFunction() {}
const secretKey = "12345";

export { workerFunction, secretKey as publicToken };
`;
  const result = extractSymbolsFromSource({
    relativePath: "src/tokens.ts",
    sourceText: code,
  });

  const worker = result.symbols.find((s) => s.name === "workerFunction");
  assert.ok(worker);
  assert.equal(worker.exported.isExported, true);
  assert.equal(worker.exported.exportName, "workerFunction");

  const secret = result.symbols.find((s) => s.name === "secretKey");
  assert.ok(secret);
  assert.equal(secret.exported.isExported, true);
  assert.equal(secret.exported.exportName, "publicToken");
});

test("10. default exports recognize default export function, class, and export default identifier", () => {
  const funcCode = `
export default function mainEntry() {}
`;
  const funcRes = extractSymbolsFromSource({
    relativePath: "src/main.ts",
    sourceText: funcCode,
  });
  const mainFunc = funcRes.symbols.find((s) => s.name === "mainEntry");
  assert.ok(mainFunc);
  assert.equal(mainFunc.exported.isExported, true);
  assert.equal(mainFunc.exported.isDefaultExport, true);
  assert.equal(mainFunc.exported.exportName, "default");

  const classCode = `
export default class AppContainer {}
`;
  const classRes = extractSymbolsFromSource({
    relativePath: "src/container.ts",
    sourceText: classCode,
  });
  const appClass = classRes.symbols.find((s) => s.name === "AppContainer");
  assert.ok(appClass);
  assert.equal(appClass.exported.isExported, true);
  assert.equal(appClass.exported.isDefaultExport, true);

  const identCode = `
const handler = async () => {};
export default handler;
`;
  const identRes = extractSymbolsFromSource({
    relativePath: "src/handler.ts",
    sourceText: identCode,
  });
  const handlerSym = identRes.symbols.find((s) => s.name === "handler");
  assert.ok(handlerSym);
  assert.equal(handlerSym.exported.isExported, true);
  assert.equal(handlerSym.exported.isDefaultExport, true);
  assert.equal(handlerSym.exported.exportName, "default");
});

test("11. nested symbols record parent relationship deterministically", () => {
  const code = `
export class PaymentService {
  async charge() {}
  refund() {}
}
`;
  const res = extractSymbolsFromSource({
    relativePath: "src/payment.ts",
    sourceText: code,
  });

  assert.equal(res.symbols.length, 3);
  const cls = res.symbols.find((s) => s.kind === "class");
  assert.ok(cls);
  assert.equal(cls.name, "PaymentService");

  const charge = res.symbols.find((s) => s.name === "charge");
  assert.ok(charge);
  assert.equal(charge.kind, "method");
  assert.equal(charge.parentSymbolId, cls.id);
  assert.equal(charge.parentName, "PaymentService");
  assert.ok(charge.id.includes("PaymentService.charge"));

  const refund = res.symbols.find((s) => s.name === "refund");
  assert.ok(refund);
  assert.equal(refund.kind, "method");
  assert.equal(refund.parentSymbolId, cls.id);
  assert.equal(refund.parentName, "PaymentService");
});

test("12. source locations accurately track 1-based line/col and 0-based offset on multi-line constructs", () => {
  const code = `// line 1
// line 2
export function processBatch(
  batchId: string,
  count: number,
): void {
  return;
}
`;
  const res = extractSymbolsFromSource({
    relativePath: "src/batch.ts",
    sourceText: code,
  });

  const sym = res.symbols.find((s) => s.name === "processBatch");
  assert.ok(sym);
  assert.equal(sym.location.start.line, 3);
  assert.equal(sym.location.start.column, 1);
  assert.equal(sym.location.end.line, 8);
  assert.equal(sym.location.end.column, 2);
  assert.ok(sym.location.end.offset > sym.location.start.offset);
});

test("13. duplicate-prevention ensures declarations are not double-counted", () => {
  const code = `
export const process = () => {};
export { process };
`;
  const res = extractSymbolsFromSource({
    relativePath: "src/proc.ts",
    sourceText: code,
  });

  const matches = res.symbols.filter((s) => s.name === "process");
  assert.equal(matches.length, 1, "same declaration must not be registered multiple times");
  assert.equal(matches[0]!.exported.isExported, true);
});

test("14. unsupported file handling ignores non-code files and returns empty results", () => {
  assert.equal(isSupportedSymbolFile("README.md"), false);
  assert.equal(isSupportedSymbolFile("package.json"), false);
  assert.equal(isSupportedSymbolFile("image.png"), false);
  assert.equal(isSupportedSymbolFile("styles.css"), false);

  const res = extractSymbolsFromSource({
    relativePath: "README.md",
    sourceText: "# Fluxora Docs",
  });
  assert.equal(res.symbols.length, 0);
  assert.equal(res.diagnostics.length, 0);
});

test("15. ignored directories are strictly skipped", () => {
  assert.equal(isSupportedSymbolFile("node_modules/lib/index.ts"), false);
  assert.equal(isSupportedSymbolFile(".next/types/routes.ts"), false);
  assert.equal(isSupportedSymbolFile("dist/bundle.js"), false);
  assert.equal(isSupportedSymbolFile("coverage/report.ts"), false);

  const res = extractSymbolsFromSource({
    relativePath: "node_modules/react/index.d.ts",
    sourceText: "export function createElement(): void;",
  });
  assert.equal(res.symbols.length, 0);
});

test("16. malformed source handling records structured diagnostics without throwing", () => {
  const malformed = `
export function broken( {
  const 123 = ;
`;
  const res = extractSymbolsFromSource({
    relativePath: "src/broken.ts",
    sourceText: malformed,
  });

  assert.ok(Array.isArray(res.symbols));
  assert.ok(res.diagnostics.length > 0, "should produce structured syntax diagnostics");
  assert.equal(res.diagnostics[0]!.severity, "error");
  assert.ok(typeof res.diagnostics[0]!.line === "number");
});

test("17. deterministic repeated execution produces identical results across runs", () => {
  const code = `
export class TestA {
  methodA() {}
}
export const CONSTANT_VAL = 42;
export function runTest() {}
`;
  const res1 = extractSymbolsFromSource({ relativePath: "src/test.ts", sourceText: code });
  const res2 = extractSymbolsFromSource({ relativePath: "src/test.ts", sourceText: code });

  assert.deepEqual(res1, res2);
});

test("18. golden fixture symbol extraction extracts real-world symbols from shadcn taxonomy files", () => {
  // 1. Test app/api/posts/route.ts
  const postsRouteText = readGoldenFixtureFileText("app/api/posts/route.ts");
  const postsRes = extractSymbolsFromSource({
    relativePath: "app/api/posts/route.ts",
    sourceText: postsRouteText,
  });

  assert.equal(postsRes.diagnostics.length, 0);
  const getFunc = postsRes.symbols.find((s) => s.name === "GET");
  assert.ok(getFunc);
  assert.equal(getFunc.kind, "function");
  assert.equal(getFunc.exported.isExported, true);
  assert.equal(getFunc.metadata?.isAsync, true);

  const postFunc = postsRes.symbols.find((s) => s.name === "POST");
  assert.ok(postFunc);
  assert.equal(postFunc.kind, "function");
  assert.equal(postFunc.exported.isExported, true);
  assert.equal(postFunc.metadata?.isAsync, true);

  // 2. Test components/user-auth-form.tsx (TSX component + interface + imports/types)
  const authFormText = readGoldenFixtureFileText("components/user-auth-form.tsx");
  const authFormRes = extractSymbolsFromSource({
    relativePath: "components/user-auth-form.tsx",
    sourceText: authFormText,
  });

  assert.equal(authFormRes.diagnostics.length, 0);
  const userAuthForm = authFormRes.symbols.find((s) => s.name === "UserAuthForm");
  assert.ok(userAuthForm);
  assert.equal(userAuthForm.kind, "function");
  assert.equal(userAuthForm.exported.isExported, true);

  const authProps = authFormRes.symbols.find((s) => s.name === "UserAuthFormProps");
  assert.ok(authProps);
  assert.equal(authProps.kind, "interface");

  // 3. Test lib/session.ts
  const sessionText = readGoldenFixtureFileText("lib/session.ts");
  const sessionRes = extractSymbolsFromSource({
    relativePath: "lib/session.ts",
    sourceText: sessionText,
  });

  assert.equal(sessionRes.diagnostics.length, 0);
  const getCurrentUser = sessionRes.symbols.find((s) => s.name === "getCurrentUser");
  assert.ok(getCurrentUser);
  assert.equal(getCurrentUser.kind, "function");
  assert.equal(getCurrentUser.exported.isExported, true);
  assert.equal(getCurrentUser.metadata?.isAsync, true);

  // 4. Test types/index.d.ts
  const typesText = readGoldenFixtureFileText("types/index.d.ts");
  const typesRes = extractSymbolsFromSource({
    relativePath: "types/index.d.ts",
    sourceText: typesText,
  });

  assert.equal(typesRes.diagnostics.length, 0);
  const subPlan = typesRes.symbols.find((s) => s.name === "SubscriptionPlan");
  assert.ok(subPlan);
  assert.equal(subPlan.kind, "type_alias");
  assert.equal(subPlan.exported.isExported, true);

  // 5. Test config/subscriptions.ts
  const subText = readGoldenFixtureFileText("config/subscriptions.ts");
  const subRes = extractSymbolsFromSource({
    relativePath: "config/subscriptions.ts",
    sourceText: subText,
  });

  assert.equal(subRes.diagnostics.length, 0);
  const freePlan = subRes.symbols.find((s) => s.name === "freePlan");
  assert.ok(freePlan);
  assert.equal(freePlan.kind, "constant");
  assert.equal(freePlan.exported.isExported, true);
  const proPlan = subRes.symbols.find((s) => s.name === "proPlan");
  assert.ok(proPlan);
  assert.equal(proPlan.kind, "constant");
  assert.equal(proPlan.exported.isExported, true);
});

