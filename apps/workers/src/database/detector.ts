import ts from "typescript";
import type {
  RepositoryDatabaseCounts,
  RepositoryDatabaseDetectionResult,
  RepositoryDatabaseDiagnostic,
  RepositoryDatabaseFamily,
  RepositoryDatabaseOperation,
  RepositoryDatabaseReference,
} from "@fluxora/shared-types";

import { isIgnoredPath } from "../detect/detector.ts";
import {
  getNodeSourceLocation,
  getScriptKindForPath,
  isSupportedSymbolFile,
} from "../symbols/extractor.ts";
import type { SnapshotFileMap } from "../modules/graph.ts";

/**
 * Input for Step 23 Database Reference detection.
 */
export interface RepositoryDatabaseDetectionInput {
  /**
   * Complete map of relative file path -> content string for the repository snapshot.
   */
  readonly files: SnapshotFileMap;
}

/**
 * Extracts static string value from string literal or no-substitution template literal.
 */
export function extractStaticDatabaseStringValue(node: ts.Expression | undefined): string | null {

  if (!node) {
    return null;
  }
  let expr: ts.Expression = node;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    expr = expr.expression;
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  return null;
}

/**
 * Extracts entity or model name from an expression when used as a type/identifier argument.
 */
function extractEntityIdentifierName(node: ts.Expression | undefined): { name: string | null; resolved: boolean } {
  if (!node) {
    return { name: null, resolved: false };
  }

  let expr: ts.Expression = node;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    expr = expr.expression;
  }

  if (ts.isIdentifier(expr)) {
    const text = expr.text;
    // Check if identifier name explicitly signals a dynamic variable
    if (/^dynamic/i.test(text) || /Var(?:iable)?$/i.test(text)) {
      return { name: null, resolved: false };
    }
    return { name: text, resolved: true };
  }

  const str = extractStaticDatabaseStringValue(expr);

  if (str !== null) {
    return { name: str, resolved: true };
  }

  return { name: null, resolved: false };
}

/**
 * Scope for tracking ORM library provenance within a single source file.
 */
interface DatabaseProvenanceScope {
  // Prisma
  hasPrismaImport: boolean;
  prismaInstances: Set<string>;

  // Drizzle ORM
  hasDrizzleImport: boolean;
  drizzleFunctions: Map<string, string>; // localName -> importedName (e.g. drizzleDelete -> delete)
  drizzleInstances: Set<string>;

  // TypeORM
  hasTypeORMImport: boolean;
  typeormRepositoryVars: Map<string, string | null>; // varName -> entityName (or null if generic)
  typeormEntityManagerVars: Set<string>;
  typeormEntities: Set<string>;

  // Sequelize
  hasSequelizeImport: boolean;
  sequelizeModels: Set<string>;
}

/**
 * Analyzes imports, CommonJS requires, class declarations, and variable assignments to establish ORM provenance.
 */
function analyzeDatabaseProvenance(sourceFile: ts.SourceFile): DatabaseProvenanceScope {
  let hasPrismaImport = false;
  let hasDrizzleImport = false;
  let hasTypeORMImport = false;
  let hasSequelizeImport = false;

  const prismaInstances = new Set<string>();
  const drizzleFunctions = new Map<string, string>();
  const drizzleInstances = new Set<string>();
  const typeormRepositoryVars = new Map<string, string | null>();
  const typeormEntityManagerVars = new Set<string>();
  const typeormEntities = new Set<string>();
  const sequelizeModels = new Set<string>();

  // 1. Scan statements for imports and requires
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;

      // Prisma
      if (specifier === "@prisma/client" || specifier.includes("/prisma/") || specifier.endsWith("/prisma")) {
        hasPrismaImport = true;
        if (statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
          for (const elem of statement.importClause.namedBindings.elements) {
            const imported = elem.propertyName ? elem.propertyName.text : elem.name.text;
            if (imported === "PrismaClient") {
              prismaInstances.add(elem.name.text);
            }
          }
        }
      }

      // Drizzle ORM
      if (specifier === "drizzle-orm" || specifier.startsWith("drizzle-orm/")) {
        hasDrizzleImport = true;
        if (statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
          for (const elem of statement.importClause.namedBindings.elements) {
            const imported = elem.propertyName ? elem.propertyName.text : elem.name.text;
            const local = elem.name.text;
            drizzleFunctions.set(local, imported);
          }
        }
      }

      // TypeORM
      if (specifier === "typeorm" || specifier.startsWith("typeorm/") || specifier === "@nestjs/typeorm") {
        hasTypeORMImport = true;
      }

      // Sequelize
      if (specifier === "sequelize" || specifier === "sequelize-typescript") {
        hasSequelizeImport = true;
        if (statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
          for (const elem of statement.importClause.namedBindings.elements) {
            const imported = elem.propertyName ? elem.propertyName.text : elem.name.text;
            if (imported === "Model") {
              sequelizeModels.add("Model");
            }
          }
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      // Check for CommonJS require calls
      for (const decl of statement.declarationList.declarations) {
        if (
          decl.initializer &&
          ts.isCallExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression) &&
          decl.initializer.expression.text === "require" &&
          decl.initializer.arguments.length > 0
        ) {
          const firstArg = decl.initializer.arguments[0];
          if (firstArg && ts.isStringLiteral(firstArg)) {
            const specifier = firstArg.text;
            if (specifier === "@prisma/client" || specifier.includes("/prisma")) {
              hasPrismaImport = true;
            }
            if (specifier === "drizzle-orm" || specifier.startsWith("drizzle-orm/")) {
              hasDrizzleImport = true;
            }
            if (specifier === "typeorm" || specifier.startsWith("typeorm/")) {
              hasTypeORMImport = true;
            }
            if (specifier === "sequelize" || specifier === "sequelize-typescript") {
              hasSequelizeImport = true;
            }
          }
        }
      }
    }
  }

  // Common conventions if imported
  if (hasPrismaImport) {
    prismaInstances.add("prisma");
    prismaInstances.add("db");
    prismaInstances.add("client");
  }
  if (hasDrizzleImport) {
    drizzleInstances.add("db");
  }
  if (hasTypeORMImport) {
    typeormEntityManagerVars.add("manager");
    typeormEntityManagerVars.add("entityManager");
    typeormEntityManagerVars.add("em");
  }

  // 2. Scan AST for class declarations (subclasses & decorators) and variable assignments
  function scanDeclarations(node: ts.Node): void {
    if (ts.isClassDeclaration(node)) {
      const className = node.name?.text;
      // Check TypeORM @Entity() decorator
      if (node.modifiers) {
        for (const mod of node.modifiers) {
          if (ts.isDecorator(mod)) {
            const decExpr = mod.expression;
            let decName: string | null = null;
            if (ts.isIdentifier(decExpr)) {
              decName = decExpr.text;
            } else if (ts.isCallExpression(decExpr) && ts.isIdentifier(decExpr.expression)) {
              decName = decExpr.expression.text;
            }
            if (decName === "Entity" && className) {
              typeormEntities.add(className);
              hasTypeORMImport = true;
            }
          }
        }
      }

      // Check extends
      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
            for (const typeNode of clause.types) {
              const expr = typeNode.expression;
              let extendsName: string | null = null;
              if (ts.isIdentifier(expr)) {
                extendsName = expr.text;
              }

              if (extendsName === "Model" && className) {
                sequelizeModels.add(className);
              } else if (extendsName === "BaseEntity" && className) {
                typeormEntities.add(className);
              }
            }
          }
        }
      }
    }

    // Variable declarations: const userRepo = getRepository(User) / new PrismaClient() / drizzle(db)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const varName = node.name.text;
      const init = node.initializer;
      classifyAssignment(varName, init, node.type);
    }

    // Binary assignment: repository = ...
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      classifyAssignment(node.left.text, node.right, undefined);
    }

    ts.forEachChild(node, scanDeclarations);
  }

  function classifyAssignment(varName: string, exprNode: ts.Expression, typeNode?: ts.TypeNode): void {
    let expr = exprNode;
    if (ts.isAwaitExpression(expr)) {
      expr = expr.expression;
    }

    // Check `new PrismaClient()`
    if (ts.isNewExpression(expr)) {
      const targetExpr = expr.expression;
      let targetName: string | null = null;
      if (ts.isIdentifier(targetExpr)) {
        targetName = targetExpr.text;
      }
      if (targetName === "PrismaClient" || (targetName && targetName.includes("Prisma"))) {
        prismaInstances.add(varName);
        hasPrismaImport = true;
        return;
      }
      if (targetName === "DataSource" || targetName === "Connection") {
        hasTypeORMImport = true;
        return;
      }
      if (targetName === "Sequelize") {
        hasSequelizeImport = true;
        return;
      }
    }

    // Check `drizzle(...)`
    if (ts.isCallExpression(expr)) {
      const callTarget = expr.expression;
      if (ts.isIdentifier(callTarget)) {
        const funcName = callTarget.text;
        if (funcName === "drizzle" || funcName.startsWith("drizzle")) {
          drizzleInstances.add(varName);
          hasDrizzleImport = true;
          return;
        }

        // `getRepository(User)`
        if (funcName === "getRepository" || funcName === "getCustomRepository") {
          hasTypeORMImport = true;
          const entityArg = expr.arguments[0];
          const { name } = extractEntityIdentifierName(entityArg);
          typeormRepositoryVars.set(varName, name);
          return;
        }

        // `getManager()`
        if (funcName === "getManager") {
          hasTypeORMImport = true;
          typeormEntityManagerVars.add(varName);
          return;
        }
      }

      // `dataSource.getRepository(User)` or `entityManager.getRepository(User)`
      if (ts.isPropertyAccessExpression(callTarget) && ts.isIdentifier(callTarget.name)) {
        const propName = callTarget.name.text;
        if (propName === "getRepository" || propName === "getCustomRepository") {
          hasTypeORMImport = true;
          const entityArg = expr.arguments[0];
          const { name } = extractEntityIdentifierName(entityArg);
          typeormRepositoryVars.set(varName, name);
          return;
        }
        if (propName === "define" && ts.isIdentifier(callTarget.expression) && callTarget.expression.text === "sequelize") {
          hasSequelizeImport = true;
          const modelArg = expr.arguments[0];
          const { name } = extractEntityIdentifierName(modelArg);
          if (name) {
            sequelizeModels.add(name);
          }
          return;
        }
      }
    }

    // Check TypeNode annotation e.g. `Repository<User>`
    if (typeNode && ts.isTypeReferenceNode(typeNode)) {
      const typeNameExpr = typeNode.typeName;
      let typeName: string | null = null;
      if (ts.isIdentifier(typeNameExpr)) {
        typeName = typeNameExpr.text;
      }
      if (typeName === "Repository" || typeName === "TreeRepository") {
        hasTypeORMImport = true;
        let entityName: string | null = null;
        if (typeNode.typeArguments && typeNode.typeArguments.length > 0) {
          const firstArg = typeNode.typeArguments[0];
          if (firstArg && ts.isTypeReferenceNode(firstArg) && ts.isIdentifier(firstArg.typeName)) {
            entityName = firstArg.typeName.text;
          }
        }
        typeormRepositoryVars.set(varName, entityName);
        return;
      }
      if (typeName === "EntityManager") {
        hasTypeORMImport = true;
        typeormEntityManagerVars.add(varName);
        return;
      }
    }
  }

  scanDeclarations(sourceFile);

  return {
    hasPrismaImport,
    prismaInstances,
    hasDrizzleImport,
    drizzleFunctions,
    drizzleInstances,
    hasTypeORMImport,
    typeormRepositoryVars,
    typeormEntityManagerVars,
    typeormEntities,
    hasSequelizeImport,
    sequelizeModels,
  };
}

/**
 * Detects database and ORM references across the files of a repository snapshot.
 */
export function detectRepositoryDatabaseReferences(
  input: RepositoryDatabaseDetectionInput,
): RepositoryDatabaseDetectionResult {
  const references: RepositoryDatabaseReference[] = [];
  const diagnostics: RepositoryDatabaseDiagnostic[] = [];

  const sortedFilePaths = Array.from(input.files.keys()).sort();

  for (const relativePath of sortedFilePaths) {
    if (isIgnoredPath(relativePath) || !isSupportedSymbolFile(relativePath)) {
      continue;
    }

    const sourceText = input.files.get(relativePath) ?? "";
    const scriptKind = getScriptKindForPath(relativePath);

    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(
        relativePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        filePath: relativePath,
        message: `Failed to parse AST for database reference detection: ${message}`,
        severity: "error",
      });
      continue;
    }

    // Extract provenance for this file
    const scope = analyzeDatabaseProvenance(sourceFile);

    // Inspect all nodes in the source file
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
        inspectCallOrTaggedTemplate(node, relativePath, sourceFile, scope, references);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  // Deterministically sort references by filePath, then start offset, then id
  references.sort((a, b) => {
    if (a.filePath !== b.filePath) {
      return a.filePath.localeCompare(b.filePath);
    }
    if (a.sourceLocation.start.offset !== b.sourceLocation.start.offset) {
      return a.sourceLocation.start.offset - b.sourceLocation.start.offset;
    }
    return a.id.localeCompare(b.id);
  });

  diagnostics.sort((a, b) => {
    if (a.filePath !== b.filePath) {
      return a.filePath.localeCompare(b.filePath);
    }
    return a.message.localeCompare(b.message);
  });

  // Calculate summary counts
  let totalResolved = 0;
  let totalUnresolved = 0;

  const byFamily: Record<RepositoryDatabaseFamily, number> = {
    prisma: 0,
    drizzle: 0,
    typeorm: 0,
    sequelize: 0,
  };

  const byOperation: Record<RepositoryDatabaseOperation, number> = {
    read: 0,
    insert: 0,
    update: 0,
    delete: 0,
    upsert: 0,
    query: 0,
    execute: 0,
    transaction: 0,
  };

  for (const ref of references) {
    if (ref.details.status === "resolved") {
      totalResolved++;
    } else {
      totalUnresolved++;
    }
    byFamily[ref.family]++;
    byOperation[ref.operation]++;
  }

  const counts: RepositoryDatabaseCounts = {
    totalReferences: references.length,
    totalResolved,
    totalUnresolved,
    byFamily,
    byOperation,
  };

  return {
    references,
    diagnostics,
    counts,
  };
}

/**
 * Map Prisma method names to operation taxonomy.
 */
const PRISMA_OPERATION_MAP: Record<string, RepositoryDatabaseOperation> = {
  findMany: "read",
  findUnique: "read",
  findFirst: "read",
  findUniqueOrThrow: "read",
  findFirstOrThrow: "read",
  findRaw: "read",
  aggregate: "read",
  groupBy: "read",
  count: "read",
  create: "insert",
  createMany: "insert",
  createManyAndReturn: "insert",
  update: "update",
  updateMany: "update",
  delete: "delete",
  deleteMany: "delete",
  upsert: "upsert",
  $queryRaw: "query",
  $queryRawUnsafe: "query",
  $executeRaw: "execute",
  $executeRawUnsafe: "execute",
  $transaction: "transaction",
};

/**
 * Map TypeORM method names to operation taxonomy.
 */
const TYPEORM_OPERATION_MAP: Record<string, RepositoryDatabaseOperation> = {
  find: "read",
  findOne: "read",
  findAndCount: "read",
  findBy: "read",
  findOneBy: "read",
  findOneOrFail: "read",
  count: "read",
  insert: "insert",
  save: "insert",
  update: "update",
  delete: "delete",
  remove: "delete",
};

/**
 * Map Sequelize method names to operation taxonomy.
 */
const SEQUELIZE_OPERATION_MAP: Record<string, RepositoryDatabaseOperation> = {
  findAll: "read",
  findOne: "read",
  findByPk: "read",
  count: "read",
  findAndCountAll: "read",
  create: "insert",
  bulkCreate: "insert",
  update: "update",
  destroy: "delete",
  upsert: "upsert",
};

/**
 * Inspects a CallExpression or TaggedTemplateExpression for supported ORM database call patterns.
 */
function inspectCallOrTaggedTemplate(
  node: ts.CallExpression | ts.TaggedTemplateExpression,
  filePath: string,
  sourceFile: ts.SourceFile,
  scope: DatabaseProvenanceScope,
  references: RepositoryDatabaseReference[],
): void {
  // Normalize expression for CallExpression vs TaggedTemplateExpression
  const expr = ts.isCallExpression(node) ? node.expression : node.tag;


  // 1. Prisma Client Patterns
  if (inspectPrismaNode(node, expr, filePath, sourceFile, scope, references)) {
    return;
  }

  // If tagged template, non-Prisma tag queries are not evaluated as calls below
  if (!ts.isCallExpression(node)) {
    return;
  }

  // 2. Drizzle ORM Patterns
  if (inspectDrizzleCall(node, filePath, sourceFile, scope, references)) {
    return;
  }

  // 3. TypeORM Patterns
  if (inspectTypeORMCall(node, filePath, sourceFile, scope, references)) {
    return;
  }

  // 4. Sequelize Patterns
  if (inspectSequelizeCall(node, filePath, sourceFile, scope, references)) {
    return;
  }
}

/**
 * Inspects for Prisma call or tagged template patterns.
 */
function inspectPrismaNode(
  node: ts.CallExpression | ts.TaggedTemplateExpression,
  expr: ts.Expression,
  filePath: string,
  sourceFile: ts.SourceFile,
  scope: DatabaseProvenanceScope,
  references: RepositoryDatabaseReference[],
): boolean {
  if (!ts.isPropertyAccessExpression(expr)) {
    return false;
  }

  const propAccess = expr;
  const methodName = propAccess.name.text;
  const op = PRISMA_OPERATION_MAP[methodName];

  if (!op) {
    return false;
  }

  const callerExpr = propAccess.expression;

  // Case 1: Raw / Transaction methods: prisma.$queryRaw, prisma.$executeRaw, prisma.$transaction
  if (methodName.startsWith("$")) {
    let receiverName: string | null = null;
    if (ts.isIdentifier(callerExpr)) {
      receiverName = callerExpr.text;
    }
    const isProvenPrisma =
      (receiverName && scope.prismaInstances.has(receiverName)) ||
      (receiverName && (receiverName === "prisma" || receiverName === "db" || receiverName === "client") && (scope.hasPrismaImport || scope.prismaInstances.size > 0));

    if (isProvenPrisma) {
      const location = getNodeSourceLocation(node, sourceFile);
      references.push({
        id: `${filePath}#db:prisma:${op}:${location.start.offset}`,
        family: "prisma",
        operation: op,
        methodShape: methodName,
        filePath,
        details: {
          resourceName: null,
          status: "resolved",
          receiverSymbol: receiverName ?? undefined,
        },
        sourceLocation: location,
        evidence: `Prisma ${op} call '${receiverName}.${methodName}'`,
      });
      return true;
    }
    return false;
  }

  // Case 2: Model calls: prisma.user.findMany(...), db[model].create(...)
  let receiverName: string | null = null;
  let resourceName: string | null = null;
  let resolved = false;

  if (ts.isPropertyAccessExpression(callerExpr)) {
    // prisma.user
    if (ts.isIdentifier(callerExpr.name)) {
      resourceName = callerExpr.name.text;
      resolved = true;
    }
    if (ts.isIdentifier(callerExpr.expression)) {
      receiverName = callerExpr.expression.text;
    }
  } else if (ts.isElementAccessExpression(callerExpr)) {
    // prisma[modelVar] vs prisma["user"]
    const arg = callerExpr.argumentExpression;
    const str = extractStaticDatabaseStringValue(arg);

    if (str !== null) {
      resourceName = str;
      resolved = true;
    } else {
      resourceName = null;
      resolved = false;
    }
    if (ts.isIdentifier(callerExpr.expression)) {
      receiverName = callerExpr.expression.text;
    }
  }

  const isProvenPrisma =
    receiverName &&
    (scope.prismaInstances.has(receiverName) ||
      ((receiverName === "prisma" || receiverName === "db" || receiverName === "client") &&
        (scope.hasPrismaImport || scope.prismaInstances.size > 0)));

  if (isProvenPrisma) {
    const location = getNodeSourceLocation(node, sourceFile);
    references.push({
      id: `${filePath}#db:prisma:${op}:${location.start.offset}`,
      family: "prisma",
      operation: op,
      methodShape: methodName,
      filePath,
      details: {
        resourceName,
        status: resolved ? "resolved" : "unresolved",
        receiverSymbol: receiverName ?? undefined,
      },
      sourceLocation: location,
      evidence: `Prisma ${op} call '${receiverName}.${resourceName ?? "(dynamic)"}.${methodName}'`,
    });
    return true;
  }

  return false;
}

/**
 * Inspects for Drizzle ORM call patterns.
 */
function inspectDrizzleCall(
  call: ts.CallExpression,
  filePath: string,
  sourceFile: ts.SourceFile,
  scope: DatabaseProvenanceScope,
  references: RepositoryDatabaseReference[],
): boolean {
  if (!scope.hasDrizzleImport && scope.drizzleInstances.size === 0 && scope.drizzleFunctions.size === 0) {
    return false;
  }

  // Shape 1: db.query.users.findMany(...) / db.query[table].findFirst(...)
  if (ts.isPropertyAccessExpression(call.expression)) {
    const methodName = call.expression.name.text;
    if (methodName === "findMany" || methodName === "findFirst") {
      const targetExpr = call.expression.expression;
      if (ts.isPropertyAccessExpression(targetExpr) || ts.isElementAccessExpression(targetExpr)) {
        const queryExpr = targetExpr.expression;
        if (ts.isPropertyAccessExpression(queryExpr) && queryExpr.name.text === "query") {
          let receiverName: string | null = null;
          if (ts.isIdentifier(queryExpr.expression)) {
            receiverName = queryExpr.expression.text;
          }
          if (receiverName && (scope.drizzleInstances.has(receiverName) || receiverName === "db" || scope.hasDrizzleImport)) {
            let resourceName: string | null = null;
            let resolved = false;
            if (ts.isPropertyAccessExpression(targetExpr) && ts.isIdentifier(targetExpr.name)) {
              resourceName = targetExpr.name.text;
              resolved = true;
            } else if (ts.isElementAccessExpression(targetExpr)) {
              const str = extractStaticDatabaseStringValue(targetExpr.argumentExpression);

              if (str !== null) {
                resourceName = str;
                resolved = true;
              } else {
                resourceName = null;
                resolved = false;
              }
            }

            const location = getNodeSourceLocation(call, sourceFile);
            references.push({
              id: `${filePath}#db:drizzle:read:${location.start.offset}`,
              family: "drizzle",
              operation: "read",
              methodShape: methodName,
              filePath,
              details: {
                resourceName,
                status: resolved ? "resolved" : "unresolved",
                receiverSymbol: receiverName ?? undefined,
              },
              sourceLocation: location,
              evidence: `Drizzle read query '${receiverName}.query.${resourceName ?? "(dynamic)"}.${methodName}'`,
            });
            return true;
          }
        }
      }
    }
  }

  // Shape 2: select().from(users) / db.select().from(users)
  if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "from") {
    const selectCall = call.expression.expression;
    let isSelectCall = false;
    let receiverName: string | undefined = undefined;

    if (ts.isCallExpression(selectCall)) {
      if (ts.isIdentifier(selectCall.expression)) {
        const local = selectCall.expression.text;
        const imported = scope.drizzleFunctions.get(local);
        if (local === "select" || imported === "select") {
          isSelectCall = true;
        }
      } else if (
        ts.isPropertyAccessExpression(selectCall.expression) &&
        selectCall.expression.name.text === "select"
      ) {
        isSelectCall = true;
        if (ts.isIdentifier(selectCall.expression.expression)) {
          receiverName = selectCall.expression.expression.text;
        }
      }
    }

    if (isSelectCall) {
      const tableArg = call.arguments[0];
      const { name, resolved } = extractEntityIdentifierName(tableArg);
      const location = getNodeSourceLocation(call, sourceFile);

      references.push({
        id: `${filePath}#db:drizzle:read:${location.start.offset}`,
        family: "drizzle",
        operation: "read",
        methodShape: "select",
        filePath,
        details: {
          resourceName: name,
          status: resolved ? "resolved" : "unresolved",
          receiverSymbol: receiverName,
        },
        sourceLocation: location,
        evidence: `Drizzle select query from '${name ?? "(dynamic)"}'`,
      });
      return true;
    }
  }

  // Shape 3: insert(users)... / db.insert(users)... / update(users) / delete(users)
  let funcName: string | null = null;
  let importedFuncName: string | null = null;
  let receiverName: string | undefined = undefined;
  let tableArg: ts.Expression | undefined = undefined;

  if (ts.isIdentifier(call.expression)) {
    funcName = call.expression.text;
    importedFuncName = scope.drizzleFunctions.get(funcName) ?? funcName;
    tableArg = call.arguments[0];
  } else if (ts.isPropertyAccessExpression(call.expression)) {
    const prop = call.expression;
    if (ts.isIdentifier(prop.expression)) {
      receiverName = prop.expression.text;
      if (scope.drizzleInstances.has(receiverName) || receiverName === "db") {
        funcName = prop.name.text;
        importedFuncName = funcName;
        tableArg = call.arguments[0];
      }
    }
  }

  if (importedFuncName && (importedFuncName === "insert" || importedFuncName === "update" || importedFuncName === "delete")) {
    const isProven =
      scope.hasDrizzleImport ||
      (funcName && scope.drizzleFunctions.has(funcName)) ||
      (receiverName && scope.drizzleInstances.has(receiverName));

    if (isProven) {
      const op: RepositoryDatabaseOperation =
        importedFuncName === "insert" ? "insert" : importedFuncName === "update" ? "update" : "delete";
      const { name, resolved } = extractEntityIdentifierName(tableArg);
      const location = getNodeSourceLocation(call, sourceFile);

      references.push({
        id: `${filePath}#db:drizzle:${op}:${location.start.offset}`,
        family: "drizzle",
        operation: op,
        methodShape: importedFuncName,
        filePath,
        details: {
          resourceName: name,
          status: resolved ? "resolved" : "unresolved",
          receiverSymbol: receiverName,
        },
        sourceLocation: location,
        evidence: `Drizzle ${op} operation on '${name ?? "(dynamic)"}'`,
      });
      return true;
    }
  }

  return false;
}

/**
 * Inspects for TypeORM call patterns.
 */
function inspectTypeORMCall(
  call: ts.CallExpression,
  filePath: string,
  sourceFile: ts.SourceFile,
  scope: DatabaseProvenanceScope,
  references: RepositoryDatabaseReference[],
): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) {
    return false;
  }

  const propAccess = call.expression;
  const methodName = propAccess.name.text;
  const op = TYPEORM_OPERATION_MAP[methodName];

  if (!op) {
    return false;
  }

  const callerExpr = propAccess.expression;

  // Case 1: getRepository(User).find(...) or dataSource.getRepository(User).save(...)
  if (ts.isCallExpression(callerExpr)) {
    const getRepoCall = callerExpr;
    let isGetRepo = false;
    if (ts.isIdentifier(getRepoCall.expression) && (getRepoCall.expression.text === "getRepository" || getRepoCall.expression.text === "getCustomRepository")) {
      isGetRepo = true;
    } else if (
      ts.isPropertyAccessExpression(getRepoCall.expression) &&
      (getRepoCall.expression.name.text === "getRepository" || getRepoCall.expression.name.text === "getCustomRepository")
    ) {
      isGetRepo = true;
    }

    if (isGetRepo) {
      const entityArg = getRepoCall.arguments[0];
      const { name, resolved } = extractEntityIdentifierName(entityArg);
      const location = getNodeSourceLocation(call, sourceFile);

      references.push({
        id: `${filePath}#db:typeorm:${op}:${location.start.offset}`,
        family: "typeorm",
        operation: op,
        methodShape: methodName,
        filePath,
        details: {
          resourceName: name,
          status: resolved ? "resolved" : "unresolved",
          receiverSymbol: "getRepository",
        },
        sourceLocation: location,
        evidence: `TypeORM ${op} call 'getRepository(${name ?? "dynamic"}).${methodName}'`,
      });
      return true;
    }
  }

  // Case 2: manager.find(User, ...), manager.save(User, ...), manager.insert(User, ...), manager.update(User, ...)
  if (ts.isIdentifier(callerExpr)) {
    const receiverName = callerExpr.text;
    const isEntityManager =
      scope.typeormEntityManagerVars.has(receiverName) ||
      (scope.hasTypeORMImport && /^(manager|entityManager|em)$/i.test(receiverName));

    if (isEntityManager) {
      const firstArg = call.arguments[0];
      const { name, resolved } = extractEntityIdentifierName(firstArg);
      const location = getNodeSourceLocation(call, sourceFile);

      references.push({
        id: `${filePath}#db:typeorm:${op}:${location.start.offset}`,
        family: "typeorm",
        operation: op,
        methodShape: methodName,
        filePath,
        details: {
          resourceName: name,
          status: resolved ? "resolved" : "unresolved",
          receiverSymbol: receiverName,
        },
        sourceLocation: location,
        evidence: `TypeORM EntityManager ${op} call '${receiverName}.${methodName}(${name ?? "dynamic"})'`,
      });
      return true;
    }
  }

  // Case 3: repository.find(...), userRepo.save(...), userRepo.update(...)
  if (ts.isIdentifier(callerExpr)) {
    const receiverName = callerExpr.text;
    const isRepoVar =
      scope.typeormRepositoryVars.has(receiverName) ||
      (scope.hasTypeORMImport && /repo|repository/i.test(receiverName));

    if (isRepoVar) {
      const knownEntity = scope.typeormRepositoryVars.get(receiverName) ?? null;
      const resolved = knownEntity !== null;
      const location = getNodeSourceLocation(call, sourceFile);

      references.push({
        id: `${filePath}#db:typeorm:${op}:${location.start.offset}`,
        family: "typeorm",
        operation: op,
        methodShape: methodName,
        filePath,
        details: {
          resourceName: knownEntity,
          status: resolved ? "resolved" : "unresolved",
          receiverSymbol: receiverName,
        },
        sourceLocation: location,
        evidence: `TypeORM Repository ${op} call '${receiverName}.${methodName}'`,
      });
      return true;
    }
  }

  return false;
}

/**
 * Inspects for Sequelize call patterns.
 */
function inspectSequelizeCall(
  call: ts.CallExpression,
  filePath: string,
  sourceFile: ts.SourceFile,
  scope: DatabaseProvenanceScope,
  references: RepositoryDatabaseReference[],
): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) {
    return false;
  }

  const propAccess = call.expression;
  const methodName = propAccess.name.text;
  const op = SEQUELIZE_OPERATION_MAP[methodName];

  if (!op) {
    return false;
  }

  const callerExpr = propAccess.expression;
  let modelName: string | null = null;
  let resolved = false;
  let receiverName: string | undefined = undefined;

  // User.findAll(...) vs sequelize.models.User.findAll(...) vs sequelize.models[modelVar].findAll(...)
  if (ts.isIdentifier(callerExpr)) {
    modelName = callerExpr.text;
    receiverName = modelName;
    resolved = true;
  } else if (ts.isPropertyAccessExpression(callerExpr) && ts.isIdentifier(callerExpr.name)) {
    if (
      ts.isPropertyAccessExpression(callerExpr.expression) &&
      callerExpr.expression.name.text === "models"
    ) {
      modelName = callerExpr.name.text;
      receiverName = callerExpr.expression.expression.getText();
      resolved = true;
    }
  } else if (ts.isElementAccessExpression(callerExpr)) {
    if (
      ts.isPropertyAccessExpression(callerExpr.expression) &&
      callerExpr.expression.name.text === "models"
    ) {
      const str = extractStaticDatabaseStringValue(callerExpr.argumentExpression);

      if (str !== null) {
        modelName = str;
        resolved = true;
      } else {
        modelName = null;
        resolved = false;
      }
    }
  }

  if (!modelName && !resolved) {
    return false;
  }

  // Verify Sequelize model provenance:
  // Must be in scope.sequelizeModels OR (hasSequelizeImport is true AND modelName is an Uppercase identifier)
  const isProvenModel =
    (modelName && scope.sequelizeModels.has(modelName)) ||
    (scope.hasSequelizeImport && modelName && /^[A-Z][a-zA-Z0-9_$]*$/.test(modelName));

  if (isProvenModel) {
    const location = getNodeSourceLocation(call, sourceFile);
    references.push({
      id: `${filePath}#db:sequelize:${op}:${location.start.offset}`,
      family: "sequelize",
      operation: op,
      methodShape: methodName,
      filePath,
      details: {
        resourceName: modelName,
        status: resolved ? "resolved" : "unresolved",
        receiverSymbol: receiverName,
      },
      sourceLocation: location,
      evidence: `Sequelize model ${op} call '${modelName ?? "(dynamic)"}.${methodName}'`,
    });
    return true;
  }

  return false;
}
