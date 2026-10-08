import type { SourceLocation } from "./symbols.ts";

/**
 * Supported database/ORM pattern families in Step 23.
 */
export const RepositoryDatabaseFamilies = [
  "prisma",
  "drizzle",
  "typeorm",
  "sequelize",
] as const;
export type RepositoryDatabaseFamily = (typeof RepositoryDatabaseFamilies)[number];

/**
 * Standardized database operation taxonomy.
 */
export const RepositoryDatabaseOperations = [
  "read",
  "insert",
  "update",
  "delete",
  "upsert",
  "query",
  "execute",
  "transaction",
] as const;
export type RepositoryDatabaseOperation = (typeof RepositoryDatabaseOperations)[number];

/**
 * Deterministic status for whether the resource (model/table/entity) name was statically resolved.
 */
export const RepositoryDatabaseResolutionStatuses = ["resolved", "unresolved"] as const;
export type RepositoryDatabaseResolutionStatus =
  (typeof RepositoryDatabaseResolutionStatuses)[number];

/**
 * Specific semantic details extracted for a database reference.
 */
export interface RepositoryDatabaseReferenceDetails {
  /**
   * Model, table, or entity name if statically knowable (e.g. "user", "users", "User").
   * Null when unresolved / dynamic or for raw database query/execute operations.
   */
  readonly resourceName: string | null;

  /**
   * Status indicating whether the resource identifier was statically resolved.
   */
  readonly status: RepositoryDatabaseResolutionStatus;

  /**
   * Receiver or caller identifier if present (e.g. "prisma", "db", "userRepository", "User").
   */
  readonly receiverSymbol?: string | undefined;
}

/**
 * Detected database/ORM interaction point in a source file.
 */
export interface RepositoryDatabaseReference {
  /**
   * Deterministic unique identifier for this database reference occurrence.
   * Format: `${filePath}#db:${family}:${operation}:${sourceLocation.start.offset}`
   */
  readonly id: string;

  /**
   * Pattern family / library (prisma, drizzle, typeorm, sequelize).
   */
  readonly family: RepositoryDatabaseFamily;

  /**
   * Standardized operation taxonomy.
   */
  readonly operation: RepositoryDatabaseOperation;

  /**
   * Specific method or invocation shape (e.g., "findMany", "create", "select", "save", "findAll").
   */
  readonly methodShape: string;

  /**
   * Relative POSIX path in the repository snapshot.
   */
  readonly filePath: string;

  /**
   * Extracted details including resource name and resolution status.
   */
  readonly details: RepositoryDatabaseReferenceDetails;

  /**
   * Exact source location in the file.
   */
  readonly sourceLocation: SourceLocation;

  /**
   * Deterministic explanatory evidence string.
   */
  readonly evidence: string;
}

/**
 * Diagnostic report for parse anomalies or errors during database reference detection.
 */
export interface RepositoryDatabaseDiagnostic {
  readonly filePath: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity: "error" | "warning";
}

/**
 * Summary counts for deterministic verification.
 */
export interface RepositoryDatabaseCounts {
  readonly totalReferences: number;
  readonly totalResolved: number;
  readonly totalUnresolved: number;
  readonly byFamily: {
    readonly prisma: number;
    readonly drizzle: number;
    readonly typeorm: number;
    readonly sequelize: number;
  };
  readonly byOperation: {
    readonly read: number;
    readonly insert: number;
    readonly update: number;
    readonly delete: number;
    readonly upsert: number;
    readonly query: number;
    readonly execute: number;
    readonly transaction: number;
  };
}

/**
 * Complete deterministic result of Step 23 database reference detection.
 */
export interface RepositoryDatabaseDetectionResult {
  readonly references: readonly RepositoryDatabaseReference[];
  readonly diagnostics: readonly RepositoryDatabaseDiagnostic[];
  readonly counts: RepositoryDatabaseCounts;
}

