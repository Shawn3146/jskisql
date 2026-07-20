/**
 * JsKiSQL (jskisql.js) - A lightweight SQL database engine backed by localStorage.
 *
 * This module implements a minimal SQL database that stores data in localStorage.
 * It provides a DB-API 2.0-like interface including connection, cursor, execute,
 * executemany, commit, rollback, and fetch operations.
 *
 * It supports common SQL statements (CREATE TABLE, DROP TABLE, ALTER TABLE,
 * INSERT, UPDATE, DELETE, SELECT) with %s as placeholder.
 * No external SQL library is used - all SQL parsing is hand-written.
 *
 * The library binds to a <div> element to display all data and execute SQL commands.
 * Data persists in localStorage (survives page reloads).
 *
 * Usage:
 *   const db = new JsKiSQL('my_database', document.getElementById('output'));
 *   db.execute("CREATE TABLE users (id INTEGER, name TEXT)");
 *   db.execute("INSERT INTO users VALUES (%s, %s)", [1, 'Alice']);
 *   db.commit();
 *   db.query("SELECT * FROM users");
 *
 * MIT License
 * Copyright (c) 2026
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JsKiSQL = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  'use strict';

  // =========================================================================
  // Exceptions
  // =========================================================================

  /**
   * Base exception for JsKiSQL.
   */
  class JsKiSQLError extends Error {
    constructor(message) {
      super(message);
      this.name = this.constructor.name;
    }
  }

  class DatabaseError extends JsKiSQLError {}
  class OperationalError extends DatabaseError {}
  class ProgrammingError extends DatabaseError {}
  class IntegrityError extends DatabaseError {}
  class NotSupportedError extends DatabaseError {}

  // =========================================================================
  // Internal: SQL tokenizer
  // =========================================================================

  const SQL_KEYWORDS = new Set([
    'CREATE', 'TABLE', 'DROP', 'ALTER', 'ADD', 'INSERT', 'INTO', 'VALUES',
    'UPDATE', 'SET', 'DELETE', 'FROM', 'SELECT', 'WHERE', 'AND', 'OR', 'NOT',
    'NULL', 'IS', 'LIKE', 'IN', 'BETWEEN', 'ORDER', 'BY', 'ASC', 'DESC',
    'LIMIT', 'OFFSET', 'AS', 'ON', 'DISTINCT', 'ALL', 'EXISTS', 'PRIMARY',
    'KEY', 'FOREIGN', 'REFERENCES', 'INDEX', 'UNIQUE', 'CHECK', 'DEFAULT',
    'COLUMN', 'IF', 'EXISTS', 'RENAME', 'TO', 'INTEGER', 'INT', 'TEXT',
    'VARCHAR', 'CHAR', 'FLOAT', 'REAL', 'DOUBLE', 'BOOLEAN', 'BLOB', 'DATE',
    'DATETIME', 'TIMESTAMP', 'NUMERIC', 'DECIMAL',
  ]);

  /**
   * Tokenize a SQL string into an array of tokens.
   * Tokens can be: keywords, identifiers, numbers, strings, operators,
   * punctuation, and placeholders (%s).
   *
   * @param {string} sql - The SQL string to tokenize.
   * @returns {Array} Array of [type, value] token pairs.
   */
  function tokenize(sql) {
    const tokens = [];
    let i = 0;
    const length = sql.length;

    while (i < length) {
      const c = sql[i];

      // Whitespace
      if (/\s/.test(c)) {
        i++;
        continue;
      }

      // Single-line comment: --
      if (c === '-' && i + 1 < length && sql[i + 1] === '-') {
        let j = sql.indexOf('\n', i);
        if (j === -1) break;
        i = j + 1;
        continue;
      }

      // Multi-line comment: /* ... */
      if (c === '/' && i + 1 < length && sql[i + 1] === '*') {
        let j = sql.indexOf('*/', i + 2);
        if (j === -1) throw new ProgrammingError('Unterminated /* comment');
        i = j + 2;
        continue;
      }

      // String literal: '...'
      if (c === "'") {
        let j = i + 1;
        while (j < length) {
          if (sql[j] === "'") {
            if (j + 1 < length && sql[j + 1] === "'") {
              j += 2; // escaped quote ''
              continue;
            }
            break;
          }
          j++;
        }
        if (j >= length) throw new ProgrammingError('Unterminated string literal');
        tokens.push(['STRING', sql.slice(i, j + 1)]);
        i = j + 1;
        continue;
      }

      // Placeholder %s
      if (c === '%' && i + 1 < length && sql[i + 1] === 's') {
        tokens.push(['PLACEHOLDER', '%s']);
        i += 2;
        continue;
      }

      // Number
      if (/\d/.test(c) || (c === '.' && i + 1 < length && /\d/.test(sql[i + 1]))) {
        let j = i;
        let hasDot = false;
        while (j < length && (/\d/.test(sql[j]) || sql[j] === '.')) {
          if (sql[j] === '.') {
            if (hasDot) break;
            hasDot = true;
          }
          j++;
        }
        tokens.push(['NUMBER', sql.slice(i, j)]);
        i = j;
        continue;
      }

      // Identifier (quoted with double quotes or backticks)
      if (c === '"' || c === '`') {
        const quoteChar = c;
        let j = i + 1;
        while (j < length && sql[j] !== quoteChar) {
          if (sql[j] === '\\') j += 2;
          else j++;
        }
        if (j >= length) throw new ProgrammingError(`Unterminated ${quoteChar} identifier`);
        tokens.push(['IDENTIFIER', sql.slice(i + 1, j)]);
        i = j + 1;
        continue;
      }

      // Identifier or keyword (unquoted)
      if (/[a-zA-Z_]/.test(c)) {
        let j = i;
        while (j < length && (/[a-zA-Z0-9_]/.test(sql[j]))) j++;
        const word = sql.slice(i, j);
        if (SQL_KEYWORDS.has(word.toUpperCase())) {
          tokens.push(['KEYWORD', word.toUpperCase()]);
        } else {
          tokens.push(['IDENTIFIER', word]);
        }
        i = j;
        continue;
      }

      // Operators and punctuation
      if (c === ',') { tokens.push(['COMMA', ',']); i++; }
      else if (c === '(') { tokens.push(['LPAREN', '(']); i++; }
      else if (c === ')') { tokens.push(['RPAREN', ')']); i++; }
      else if (c === ';') { tokens.push(['SEMICOLON', ';']); i++; }
      else if (c === '*') { tokens.push(['STAR', '*']); i++; }
      else if (c === '=') { tokens.push(['OP', '=']); i++; }
      else if (c === '!') {
        if (i + 1 < length && sql[i + 1] === '=') {
          tokens.push(['OP', '!=']);
          i += 2;
        } else {
          throw new ProgrammingError(`Unexpected character '!' at position ${i}`);
        }
      }
      else if (c === '<') {
        if (i + 1 < length && sql[i + 1] === '=') {
          tokens.push(['OP', '<=']);
          i += 2;
        } else if (i + 1 < length && sql[i + 1] === '>') {
          tokens.push(['OP', '<>']);
          i += 2;
        } else {
          tokens.push(['OP', '<']);
          i++;
        }
      }
      else if (c === '>') {
        if (i + 1 < length && sql[i + 1] === '=') {
          tokens.push(['OP', '>=']);
          i += 2;
        } else {
          tokens.push(['OP', '>']);
          i++;
        }
      }
      else if (c === '+' || c === '-' || c === '/') {
        tokens.push(['OP', c]);
        i++;
      }
      else {
        throw new ProgrammingError(`Unexpected character '${c}' at position ${i}`);
      }
    }

    return tokens;
  }

  // =========================================================================
  // Internal: SQL parser and AST helpers
  // =========================================================================

  /**
   * Parse a CREATE TABLE statement.
   * Expected: CREATE TABLE [IF NOT EXISTS] <name> ( <col> <type>[(len)], ... )
   *
   * @param {Array} tokens - Token array.
   * @returns {Object} AST dict.
   */
  function parseCreateTable(tokens) {
    let pos = 0;
    if (tokens[pos][1] !== 'CREATE') throw new ProgrammingError('Expected CREATE');
    pos++;
    if (tokens[pos][1] !== 'TABLE') throw new ProgrammingError('Expected TABLE');
    pos++;

    let ifNotExists = false;
    if (tokens[pos][1] === 'IF') {
      pos++;
      if (tokens[pos][1] !== 'NOT') throw new ProgrammingError('Expected NOT');
      pos++;
      if (tokens[pos][1] !== 'EXISTS') throw new ProgrammingError('Expected EXISTS');
      pos++;
      ifNotExists = true;
    }

    if (tokens[pos][0] !== 'IDENTIFIER') throw new ProgrammingError('Expected table name');
    const tableName = tokens[pos][1];
    pos++;

    if (tokens[pos][0] !== 'LPAREN') throw new ProgrammingError('Expected (');
    pos++;

    const columns = [];
    while (pos < tokens.length && tokens[pos][0] !== 'RPAREN') {
      if (tokens[pos][0] !== 'IDENTIFIER') {
        throw new ProgrammingError(`Expected column name, got ${JSON.stringify(tokens[pos])}`);
      }
      const colName = tokens[pos][1];
      pos++;

      if (tokens[pos][0] !== 'IDENTIFIER' && tokens[pos][0] !== 'KEYWORD') {
        throw new ProgrammingError(`Expected type, got ${JSON.stringify(tokens[pos])}`);
      }
      const colType = tokens[pos][1].toUpperCase();
      pos++;

      let colLength = null;
      if (tokens[pos][0] === 'LPAREN') {
        pos++;
        if (tokens[pos][0] !== 'NUMBER') throw new ProgrammingError('Expected number for length');
        colLength = parseInt(tokens[pos][1], 10);
        pos++;
        if (tokens[pos][0] !== 'RPAREN') throw new ProgrammingError('Expected ) after length');
        pos++;
      }

      columns.push({
        name: colName,
        type: colType,
        length: colLength,
      });

      if (tokens[pos][0] === 'COMMA') {
        pos++;
      } else if (tokens[pos][0] === 'RPAREN') {
        break;
      } else {
        throw new ProgrammingError(`Expected ',' or ')', got ${JSON.stringify(tokens[pos])}`);
      }
    }

    if (tokens[pos][0] !== 'RPAREN') throw new ProgrammingError('Expected )');
    pos++;

    if (pos < tokens.length && tokens[pos][0] === 'SEMICOLON') pos++;

    return {
      type: 'CREATE_TABLE',
      tableName: tableName,
      columns: columns,
      ifNotExists: ifNotExists,
    };
  }

  /**
   * Parse a DROP TABLE statement.
   *
   * @param {Array} tokens - Token array.
   * @returns {Object} AST dict.
   */
  function parseDropTable(tokens) {
    let pos = 0;
    if (tokens[pos][1] !== 'DROP') throw new ProgrammingError('Expected DROP');
    pos++;
    if (tokens[pos][1] !== 'TABLE') throw new ProgrammingError('Expected TABLE');
    pos++;

    let ifExists = false;
    if (tokens[pos][1] === 'IF') {
      pos++;
      if (tokens[pos][1] !== 'EXISTS') throw new ProgrammingError('Expected EXISTS');
      pos++;
      ifExists = true;
    }

    if (tokens[pos][0] !== 'IDENTIFIER') throw new ProgrammingError('Expected table name');
    const tableName = tokens[pos][1];
    pos++;

    if (pos < tokens.length && tokens[pos][0] === 'SEMICOLON') pos++;

    return {
      type: 'DROP_TABLE',
      tableName: tableName,
      ifExists: ifExists,
    };
  }

  /**
   * Parse an ALTER TABLE statement.
   * Supports: ADD COLUMN, DROP COLUMN, RENAME TO.
   *
   * @param {Array} tokens - Token array.
   * @returns {Object} AST dict.
   */
  function parseAlterTable(tokens) {
    let pos = 0;
    if (tokens[pos][1] !== 'ALTER') throw new ProgrammingError('Expected ALTER');
    pos++;
    if (tokens[pos][1] !== 'TABLE') throw new ProgrammingError('Expected TABLE');
    pos++;

    if (tokens[pos][0] !== 'IDENTIFIER') throw new ProgrammingError('Expected table name');
    const tableName = tokens[pos][1];
    pos++;

    if (tokens[pos][1] === 'ADD') {
      pos++;
      if (tokens[pos][1] === 'COLUMN') pos++;
      if (tokens[pos][0] !== 'IDENTIFIER') throw new ProgrammingError('Expected column name');
      const colName = tokens[pos][1];
      pos++;
      if (tokens[pos][0] !== 'IDENTIFIER' && tokens[pos][0] !== 'KEYWORD') {
        throw new ProgrammingError('Expected column type');
      }
      const colType = tokens[pos][1].toUpperCase();
      pos++;
      let colLength = null;
      if (tokens[pos][0] === 'LPAREN') {
        pos++;
        if (tokens[pos][0] !== 'NUMBER') throw new ProgrammingError('Expected number');
        colLength = parseInt(tokens[pos][1], 10);
        pos++;
        if (tokens[pos][0] !== 'RPAREN') throw new ProgrammingError('Expected )');
        pos++;
      }
      return {
        type: 'ALTER_TABLE',
        tableName: tableName,
        operation: 'ADD_COLUMN',
        columnName: colName,
        columnType: colType,
        columnLength: colLength,
      };
    } else if (tokens[pos][1] === 'DROP') {
      pos++;
      if (tokens[pos][1] === 'COLUMN') pos++;
      if (tokens[pos][0] !== 'IDENTIFIER') throw new ProgrammingError('Expected column name');
      const colName = tokens[pos][1];
      pos++;
      return {
        type: 'ALTER_TABLE',
        tableName: tableName,
        operation: 'DROP_COLUMN',
        columnName: colName,
      };
    } else if (tokens[pos][1] === 'RENAME') {
      pos++;
      if (tokens[pos][1] !== 'TO') throw new ProgrammingError('Expected TO');
      pos++;
      if (tokens[pos][0] !== 'IDENTIFIER') throw new ProgrammingError('Expected new table name');
      const newName = tokens[pos][1];
      pos++;
      return {
        type: 'ALTER_TABLE',
        tableName: tableName,
        operation: 'RENAME_TO',
        newName: newName,
      };
    } else {
      throw new ProgrammingError(`Unsupported ALTER TABLE operation: ${tokens[pos][1]}`);
    }
  }

  /**
   * Parse WHERE clause from token list starting at 'start'.
   * Returns { conditions, newPos }.
   *
   * @param {Array} tokens - Token array.
   * @param {number} start - Starting position.
   * @returns {Object|null} { conditions, newPos } or null if no WHERE.
   */
  function parseWhere(tokens, start) {
    let pos = start;

    if (pos >= tokens.length || tokens[pos][1] !== 'WHERE') {
      return { conditions: null, newPos: start };
    }
    pos++; // skip WHERE

    const conditions = [];
    let currentOp = 'AND';

    while (pos < tokens.length && tokens[pos][0] !== 'SEMICOLON') {
      if (tokens[pos][0] === 'LPAREN') {
        pos++;
        continue;
      }
      if (tokens[pos][0] === 'RPAREN') {
        pos++;
        continue;
      }
      if (tokens[pos][1] === 'AND' || tokens[pos][1] === 'OR') {
        currentOp = tokens[pos][1];
        pos++;
        continue;
      }

      // Expect identifier (column name)
      if (tokens[pos][0] !== 'IDENTIFIER') {
        throw new ProgrammingError(`Expected column in WHERE, got ${JSON.stringify(tokens[pos])}`);
      }
      const colName = tokens[pos][1];
      pos++;

      // Operator
      if (tokens[pos][0] === 'OP') {
        const op = tokens[pos][1];
        pos++;

        // Value
        if (tokens[pos][0] === 'STRING' || tokens[pos][0] === 'NUMBER') {
          const rawVal = tokens[pos][1];
          pos++;
          const val = parseLiteral(rawVal);
          conditions.push([colName, op, val, currentOp]);
        } else if (tokens[pos][0] === 'PLACEHOLDER') {
          conditions.push([colName, op, '%s', currentOp]);
          pos++;
        } else if (tokens[pos][1] === 'NULL') {
          conditions.push([colName, op, null, currentOp]);
          pos++;
        } else {
          throw new ProgrammingError(`Unexpected value in WHERE: ${JSON.stringify(tokens[pos])}`);
        }
      } else if (tokens[pos][1] === 'IS') {
        pos++;
        let negated = false;
        if (tokens[pos][1] === 'NOT') {
          negated = true;
          pos++;
        }
        if (tokens[pos][1] !== 'NULL') throw new ProgrammingError('Expected NULL after IS');
        pos++;
        if (negated) {
          conditions.push([colName, 'IS NOT', null, currentOp]);
        } else {
          conditions.push([colName, 'IS', null, currentOp]);
        }
      } else if (tokens[pos][1] === 'IN') {
        pos++;
        if (tokens[pos][0] !== 'LPAREN') throw new ProgrammingError('Expected ( after IN');
        pos++;
        const values = [];
        while (tokens[pos][0] !== 'RPAREN') {
          if (tokens[pos][0] === 'STRING' || tokens[pos][0] === 'NUMBER') {
            values.push(parseLiteral(tokens[pos][1]));
            pos++;
          } else if (tokens[pos][0] === 'PLACEHOLDER') {
            values.push('%s');
            pos++;
          } else if (tokens[pos][0] === 'COMMA') {
            pos++;
          } else {
            throw new ProgrammingError(`Unexpected in IN list: ${JSON.stringify(tokens[pos])}`);
          }
        }
        pos++; // skip RPAREN
        conditions.push([colName, 'IN', values, currentOp]);
      } else if (tokens[pos][1] === 'LIKE') {
        pos++;
        if (tokens[pos][0] === 'STRING') {
          conditions.push([colName, 'LIKE', parseLiteral(tokens[pos][1]), currentOp]);
          pos++;
        } else if (tokens[pos][0] === 'PLACEHOLDER') {
          conditions.push([colName, 'LIKE', '%s', currentOp]);
          pos++;
        } else {
          throw new ProgrammingError(`Unexpected in LIKE: ${JSON.stringify(tokens[pos])}`);
        }
      } else if (tokens[pos][1] === 'BETWEEN') {
        pos++;
        let v1 = tokens[pos][0] === 'STRING' || tokens[pos][0] === 'NUMBER'
          ? parseLiteral(tokens[pos][1]) : '%s';
        if (tokens[pos][0] === 'STRING' || tokens[pos][0] === 'NUMBER') pos++;
        else if (tokens[pos][0] === 'PLACEHOLDER') pos++;
        else throw new ProgrammingError('Unexpected in BETWEEN');

        if (tokens[pos][1] !== 'AND') throw new ProgrammingError('Expected AND in BETWEEN');
        pos++;

        let v2 = tokens[pos][0] === 'STRING' || tokens[pos][0] === 'NUMBER'
          ? parseLiteral(tokens[pos][1]) : '%s';
        if (tokens[pos][0] === 'STRING' || tokens[pos][0] === 'NUMBER') pos++;
        else if (tokens[pos][0] === 'PLACEHOLDER') pos++;
        else throw new ProgrammingError('Unexpected in BETWEEN');

        conditions.push([colName, 'BETWEEN', [v1, v2], currentOp]);
      } else {
        throw new ProgrammingError(`Unexpected token in WHERE: ${JSON.stringify(tokens[pos])}`);
      }
    }

    return { conditions: conditions, newPos: pos };
  }

  /**
   * Parse a token string into a JavaScript literal value.
   *
   * @param {string} raw - Raw token string.
   * @returns {*} Parsed value.
   */
  function parseLiteral(raw) {
    if (typeof raw === 'string' && raw.startsWith("'") && raw.endsWith("'")) {
      // Unescape SQL string
      let s = raw.slice(1, -1);
      s = s.replace(/''/g, "'");
      return s;
    }
    try {
      if (raw.indexOf('.') !== -1) return parseFloat(raw);
      return parseInt(raw, 10);
    } catch (e) {
      return raw;
    }
  }

  /**
   * Parse an INSERT INTO statement.
   *
   * @param {Array} tokens - Token array.
   * @returns {Object} AST dict.
   */
  function parseInsert(tokens) {
    let pos = 0;
    if (tokens[pos][1] !== 'INSERT') throw new ProgrammingError('Expected INSERT');
    pos++;
    if (tokens[pos][1] !== 'INTO') throw new ProgrammingError('Expected INTO');
    pos++;
    if (tokens[pos][0] !== 'IDENTIFIER') throw new ProgrammingError('Expected table name');
    const tableName = tokens[pos][1];
    pos++;

    let columns = null;
    // Check if next token is LPAREN and NOT followed by VALUES
    if (tokens[pos][0] === 'LPAREN' &&
        !(pos + 1 < tokens.length && tokens[pos + 1][1] === 'VALUES')) {
      pos++;
      columns = [];
      while (tokens[pos][0] !== 'RPAREN') {
        if (tokens[pos][0] !== 'IDENTIFIER') throw new ProgrammingError('Expected column name');
        columns.push(tokens[pos][1]);
        pos++;
        if (tokens[pos][0] === 'COMMA') pos++;
      }
      pos++; // skip RPAREN
    }

    if (tokens[pos][1] !== 'VALUES') throw new ProgrammingError('Expected VALUES');
    pos++;
    if (tokens[pos][0] !== 'LPAREN') throw new ProgrammingError('Expected (');
    pos++;

    const values = [];
    while (tokens[pos][0] !== 'RPAREN') {
      if (tokens[pos][0] === 'PLACEHOLDER') {
        values.push('%s');
        pos++;
      } else if (tokens[pos][0] === 'STRING' || tokens[pos][0] === 'NUMBER') {
        values.push(parseLiteral(tokens[pos][1]));
        pos++;
      } else if (tokens[pos][1] === 'NULL') {
        values.push(null);
        pos++;
      } else if (tokens[pos][0] === 'COMMA') {
        pos++;
      } else {
        throw new ProgrammingError(`Unexpected in VALUES: ${JSON.stringify(tokens[pos])}`);
      }
    }
    pos++; // skip RPAREN

    if (pos < tokens.length && tokens[pos][0] === 'SEMICOLON') pos++;

    return {
      type: 'INSERT',
      tableName: tableName,
      columns: columns,
      values: values,
    };
  }

  /**
   * Parse an UPDATE statement.
   *
   * @param {Array} tokens - Token array.
   * @returns {Object} AST dict.
   */
  function parseUpdate(tokens) {
    let pos = 0;
    if (tokens[pos][1] !== 'UPDATE') throw new ProgrammingError('Expected UPDATE');
    pos++;
    if (tokens[pos][0] !== 'IDENTIFIER') throw new ProgrammingError('Expected table name');
    const tableName = tokens[pos][1];
    pos++;
    if (tokens[pos][1] !== 'SET') throw new ProgrammingError('Expected SET');
    pos++;

    const setClauses = [];
    while (pos < tokens.length && tokens[pos][1] !== 'WHERE' && tokens[pos][0] !== 'SEMICOLON') {
      if (tokens[pos][0] !== 'IDENTIFIER') throw new ProgrammingError('Expected column name in SET');
      const colName = tokens[pos][1];
      pos++;
      if (tokens[pos][0] !== 'OP' || tokens[pos][1] !== '=') throw new ProgrammingError('Expected =');
      pos++;

      if (tokens[pos][0] === 'PLACEHOLDER') {
        setClauses.push([colName, '%s']);
        pos++;
      } else if (tokens[pos][0] === 'STRING' || tokens[pos][0] === 'NUMBER') {
        setClauses.push([colName, parseLiteral(tokens[pos][1])]);
        pos++;
      } else if (tokens[pos][1] === 'NULL') {
        setClauses.push([colName, null]);
        pos++;
      } else {
        throw new ProgrammingError(`Unexpected value in SET: ${JSON.stringify(tokens[pos])}`);
      }

      if (tokens[pos][0] === 'COMMA') pos++;
    }

    const whereResult = parseWhere(tokens, pos);
    const where = whereResult.conditions;
    pos = whereResult.newPos;

    if (pos < tokens.length && tokens[pos][0] === 'SEMICOLON') pos++;

    return {
      type: 'UPDATE',
      tableName: tableName,
      setClauses: setClauses,
      where: where,
    };
  }

  /**
   * Parse a DELETE FROM statement.
   *
   * @param {Array} tokens - Token array.
   * @returns {Object} AST dict.
   */
  function parseDelete(tokens) {
    let pos = 0;
    if (tokens[pos][1] !== 'DELETE') throw new ProgrammingError('Expected DELETE');
    pos++;
    if (tokens[pos][1] !== 'FROM') throw new ProgrammingError('Expected FROM');
    pos++;
    if (tokens[pos][0] !== 'IDENTIFIER') throw new ProgrammingError('Expected table name');
    const tableName = tokens[pos][1];
    pos++;

    const whereResult = parseWhere(tokens, pos);
    const where = whereResult.conditions;
    pos = whereResult.newPos;

    if (pos < tokens.length && tokens[pos][0] === 'SEMICOLON') pos++;

    return {
      type: 'DELETE',
      tableName: tableName,
      where: where,
    };
  }

  /**
   * Parse a SELECT statement.
   *
   * @param {Array} tokens - Token array.
   * @returns {Object} AST dict.
   */
  function parseSelect(tokens) {
    let pos = 0;
    if (tokens[pos][1] !== 'SELECT') throw new ProgrammingError('Expected SELECT');
    pos++;

    let columns;
    if (tokens[pos][0] === 'STAR') {
      columns = '*';
      pos++;
    } else {
      columns = [];
      while (pos < tokens.length && tokens[pos][1] !== 'FROM') {
        if (tokens[pos][0] === 'IDENTIFIER') {
          columns.push(tokens[pos][1]);
          pos++;
        } else if (tokens[pos][0] === 'COMMA') {
          pos++;
        } else {
          throw new ProgrammingError(`Unexpected in SELECT list: ${JSON.stringify(tokens[pos])}`);
        }
      }
    }

    if (tokens[pos][1] !== 'FROM') throw new ProgrammingError('Expected FROM');
    pos++;
    if (tokens[pos][0] !== 'IDENTIFIER') throw new ProgrammingError('Expected table name');
    const tableName = tokens[pos][1];
    pos++;

    const whereResult = parseWhere(tokens, pos);
    const where = whereResult.conditions;
    pos = whereResult.newPos;

    if (pos < tokens.length && tokens[pos][0] === 'SEMICOLON') pos++;

    return {
      type: 'SELECT',
      columns: columns,
      tableName: tableName,
      where: where,
    };
  }

  /**
   * Parse a single SQL statement and return an AST object.
   *
   * @param {string} sql - SQL statement string.
   * @returns {Object} AST object.
   */
  function parseSQL(sql) {
    let tokens = tokenize(sql);
    if (tokens.length === 0) throw new ProgrammingError('Empty SQL statement');

    // Remove trailing semicolons
    while (tokens.length > 0 && tokens[tokens.length - 1][0] === 'SEMICOLON') {
      tokens = tokens.slice(0, -1);
    }
    if (tokens.length === 0) throw new ProgrammingError('Empty SQL statement');

    const firstKeyword = tokens[0][1];
    if (firstKeyword === 'CREATE') return parseCreateTable(tokens);
    if (firstKeyword === 'DROP') return parseDropTable(tokens);
    if (firstKeyword === 'ALTER') return parseAlterTable(tokens);
    if (firstKeyword === 'INSERT') return parseInsert(tokens);
    if (firstKeyword === 'UPDATE') return parseUpdate(tokens);
    if (firstKeyword === 'DELETE') return parseDelete(tokens);
    if (firstKeyword === 'SELECT') return parseSelect(tokens);
    throw new ProgrammingError(`Unsupported SQL statement: ${firstKeyword}`);
  }

  // =========================================================================
  // Internal: Condition matching engine
  // =========================================================================

  /**
   * Simple LIKE matching. Supports % (any sequence) and _ (single char).
   *
   * @param {string} text - The text to test.
   * @param {string} pattern - The LIKE pattern.
   * @returns {boolean} Whether the text matches.
   */
  function likeMatch(text, pattern) {
    const regexParts = [];
    let i = 0;
    while (i < pattern.length) {
      const c = pattern[i];
      if (c === '%') regexParts.push('.*');
      else if (c === '_') regexParts.push('.');
      else if (/[.*+?^${}()|[\]\\]/.test(c)) regexParts.push('\\' + c);
      else regexParts.push(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      i++;
    }
    const regex = new RegExp('^' + regexParts.join('') + '$', 's');
    return regex.test(text);
  }

  /**
   * Check if a row object matches the WHERE conditions.
   *
   * @param {Object} row - Row data.
   * @param {Array|null} whereConditions - WHERE conditions array.
   * @param {Array|null} params - Parameter values for placeholders.
   * @param {number} paramIndex - Current parameter index.
   * @returns {{ result: boolean, paramIndex: number }}
   */
  function rowMatchesConditions(row, whereConditions, params, paramIndex) {
    if (!whereConditions) return { result: true, paramIndex: paramIndex };

    let result = null;
    let currentOp = 'AND';
    let pi = paramIndex;

    for (const cond of whereConditions) {
      const [colName, op, val, condOp] = cond;
      const actualVal = row[colName] !== undefined ? row[colName] : null;

      // Resolve placeholder if params provided
      let resolvedVal = val;
      if (val === '%s') {
        if (params !== null && pi < params.length) {
          resolvedVal = params[pi];
          pi++;
        } else {
          throw new ProgrammingError('Not enough parameters for WHERE clause');
        }
      }

      let matched = false;

      if (Array.isArray(resolvedVal) && op === 'BETWEEN') {
        let [v1, v2] = resolvedVal;
        if (v1 === '%s') { if (params && pi < params.length) { v1 = params[pi]; pi++; } }
        if (v2 === '%s') { if (params && pi < params.length) { v2 = params[pi]; pi++; } }
        matched = (actualVal !== null && v1 !== null && v2 !== null &&
                   actualVal >= v1 && actualVal <= v2);
      } else if (op === '=') {
        matched = (actualVal === resolvedVal);
      } else if (op === '!=' || op === '<>') {
        matched = (actualVal !== resolvedVal);
      } else if (op === '<') {
        matched = (actualVal !== null && resolvedVal !== null && actualVal < resolvedVal);
      } else if (op === '>') {
        matched = (actualVal !== null && resolvedVal !== null && actualVal > resolvedVal);
      } else if (op === '<=') {
        matched = (actualVal !== null && resolvedVal !== null && actualVal <= resolvedVal);
      } else if (op === '>=') {
        matched = (actualVal !== null && resolvedVal !== null && actualVal >= resolvedVal);
      } else if (op === 'IS') {
        matched = (actualVal === null || actualVal === undefined);
      } else if (op === 'IS NOT') {
        matched = (actualVal !== null && actualVal !== undefined);
      } else if (op === 'LIKE') {
        matched = likeMatch(
          actualVal !== null && actualVal !== undefined ? String(actualVal) : '',
          String(resolvedVal)
        );
      } else if (op === 'IN') {
        // Resolve placeholders in IN list
        const resolvedInList = [];
        for (const v of resolvedVal) {
          if (v === '%s') {
            if (params && pi < params.length) {
              resolvedInList.push(params[pi]);
              pi++;
            } else {
              throw new ProgrammingError('Not enough parameters for IN clause');
            }
          } else {
            resolvedInList.push(v);
          }
        }
        matched = resolvedInList.indexOf(actualVal) !== -1;
      }

      if (result === null) {
        result = matched;
      } else if (currentOp === 'AND') {
        result = result && matched;
      } else {
        result = result || matched;
      }

      currentOp = condOp;
    }

    if (result === null) return { result: true, paramIndex: pi };
    return { result: result, paramIndex: pi };
  }

  // =========================================================================
  // Internal: Storage management (localStorage)
  // =========================================================================

  /**
   * Get the localStorage key for schema data.
   *
   * @param {string} dbName - Database name.
   * @returns {string} Storage key.
   */
  function schemaKey(dbName) {
    return `jskisql_${dbName}_schema`;
  }

  /**
   * Get the localStorage key for table data.
   *
   * @param {string} dbName - Database name.
   * @returns {string} Storage key.
   */
  function dataKey(dbName) {
    return `jskisql_${dbName}_data`;
  }

  /**
   * Load database from localStorage.
   *
   * @param {string} dbName - Database name.
   * @returns {{ schema: Object, data: Object }}
   */
  function loadDatabase(dbName) {
    let schema = {};
    let data = {};

    try {
      const schemaRaw = localStorage.getItem(schemaKey(dbName));
      if (schemaRaw) schema = JSON.parse(schemaRaw);
    } catch (e) {
      schema = {};
    }

    try {
      const dataRaw = localStorage.getItem(dataKey(dbName));
      if (dataRaw) data = JSON.parse(dataRaw);
    } catch (e) {
      data = {};
    }

    return { schema: schema, data: data };
  }

  /**
   * Save database to localStorage.
   *
   * @param {string} dbName - Database name.
   * @param {Object} schema - Schema object.
   * @param {Object} data - Data object.
   */
  function saveDatabase(dbName, schema, data) {
    try {
      localStorage.setItem(schemaKey(dbName), JSON.stringify(schema));
      localStorage.setItem(dataKey(dbName), JSON.stringify(data));
    } catch (e) {
      throw new OperationalError(`Failed to save database: ${e.message}`);
    }
  }

  /**
   * Validate a row against the table schema.
   *
   * @param {Array} schemaEntry - Column definitions.
   * @param {Object} row - Row data.
   * @throws {IntegrityError} If validation fails.
   */
  function validateRow(schemaEntry, row) {
    const colNames = new Set(schemaEntry.map(c => c.name));
    for (const key of Object.keys(row)) {
      if (!colNames.has(key)) {
        throw new IntegrityError(`Column '${key}' does not exist in table schema`);
      }
    }
  }

  // =========================================================================
  // Cursor class
  // =========================================================================

  /**
   * A database cursor for executing SQL statements.
   * Mimics the DB-API 2.0 cursor interface.
   */
  class Cursor {
    /**
     * @param {Connection} connection - The parent connection.
     */
    constructor(connection) {
      this._connection = connection;
      this._description = null;
      this._results = null;
      this._rowcount = -1;
      this._arraysize = 1;
      this._lastExecuted = null;
    }

    /**
     * Read-only attribute describing the result set columns.
     * @returns {Array|null}
     */
    get description() {
      return this._description;
    }

    /**
     * Read-only attribute indicating the number of rows affected.
     * @returns {number}
     */
    get rowcount() {
      return this._rowcount;
    }

    /**
     * Read/write attribute for the number of rows to fetch at a time.
     * @returns {number}
     */
    get arraysize() {
      return this._arraysize;
    }

    set arraysize(value) {
      this._arraysize = value;
    }

    /**
     * Close the cursor.
     */
    close() {
      this._connection = null;
      this._results = null;
      this._description = null;
    }

    /**
     * Replace %s placeholders in the SQL string with escaped values.
     * Used for non-INSERT statements where we need to pre-process the SQL.
     *
     * @param {string} sql - SQL string.
     * @param {Array|null} params - Parameter values.
     * @returns {string} Resolved SQL string.
     */
    _resolvePlaceholders(sql, params) {
      if (!params) return sql;

      const paramList = Array.isArray(params) ? params.slice() : [params];
      const resultParts = [];
      let i = 0;
      let paramIdx = 0;

      while (i < sql.length) {
        if (i < sql.length - 1 && sql[i] === '%' && sql[i + 1] === 's') {
          if (paramIdx < paramList.length) {
            const val = paramList[paramIdx];
            if (val === null || val === undefined) {
              resultParts.push('NULL');
            } else if (typeof val === 'string') {
              const escaped = val.replace(/'/g, "''");
              resultParts.push(`'${escaped}'`);
            } else if (typeof val === 'boolean') {
              resultParts.push(val ? '1' : '0');
            } else {
              resultParts.push(String(val));
            }
            paramIdx++;
          } else {
            throw new ProgrammingError('Not enough parameters for placeholders');
          }
          i += 2;
        } else {
          resultParts.push(sql[i]);
          i++;
        }
      }

      return resultParts.join('');
    }

    /**
     * Execute a single SQL statement.
     *
     * @param {string} sql - SQL statement string (with %s placeholders).
     * @param {Array|null} params - Optional array of parameters.
     * @returns {Cursor} self for method chaining.
     */
    execute(sql, params) {
      this._lastExecuted = sql;
      this._results = null;
      this._description = null;
      this._rowcount = -1;

      // Resolve placeholders in the SQL text first
      let resolvedSql;
      try {
        resolvedSql = params ? this._resolvePlaceholders(sql, params) : sql;
      } catch (e) {
        throw new ProgrammingError(`SQL parameter error: ${e.message}`);
      }

      // Parse the SQL
      let ast;
      try {
        ast = parseSQL(resolvedSql);
      } catch (e) {
        if (e instanceof JsKiSQLError) throw e;
        throw new ProgrammingError(`SQL parse error: ${e.message}`);
      }

      // Get the database state
      const db = this._connection;
      const schema = db._schema;
      const data = db._data;

      if (ast.type === 'CREATE_TABLE') {
        const tableName = ast.tableName;
        if (schema[tableName]) {
          if (ast.ifNotExists) return this;
          throw new IntegrityError(`Table '${tableName}' already exists`);
        }
        schema[tableName] = ast.columns;
        data[tableName] = [];
        this._rowcount = 0;

      } else if (ast.type === 'DROP_TABLE') {
        const tableName = ast.tableName;
        if (!schema[tableName]) {
          if (ast.ifExists) return this;
          throw new IntegrityError(`Table '${tableName}' does not exist`);
        }
        const nRows = (data[tableName] || []).length;
        delete schema[tableName];
        delete data[tableName];
        this._rowcount = nRows;

      } else if (ast.type === 'ALTER_TABLE') {
        const tableName = ast.tableName;
        if (!schema[tableName]) {
          throw new IntegrityError(`Table '${tableName}' does not exist`);
        }
        const cols = schema[tableName];
        const op = ast.operation;

        if (op === 'ADD_COLUMN') {
          const colName = ast.columnName;
          if (cols.some(c => c.name === colName)) {
            throw new IntegrityError(`Column '${colName}' already exists in '${tableName}'`);
          }
          cols.push({
            name: colName,
            type: ast.columnType,
            length: ast.columnLength,
          });
          // Add column with null to existing rows
          for (const row of (data[tableName] || [])) {
            row[colName] = null;
          }
        } else if (op === 'DROP_COLUMN') {
          const colName = ast.columnName;
          const newCols = cols.filter(c => c.name !== colName);
          if (newCols.length === cols.length) {
            throw new IntegrityError(`Column '${colName}' not found in '${tableName}'`);
          }
          schema[tableName] = newCols;
          // Remove column from existing rows
          for (const row of (data[tableName] || [])) {
            delete row[colName];
          }
        } else if (op === 'RENAME_TO') {
          const newName = ast.newName;
          if (schema[newName]) {
            throw new IntegrityError(`Table '${newName}' already exists`);
          }
          schema[newName] = schema[tableName];
          data[newName] = data[tableName] || [];
          delete schema[tableName];
          delete data[tableName];
        }
        this._rowcount = 0;

      } else if (ast.type === 'INSERT') {
        const tableName = ast.tableName;
        if (!schema[tableName]) {
          throw new IntegrityError(`Table '${tableName}' does not exist`);
        }
        const colsDef = schema[tableName];
        const colNames = colsDef.map(c => c.name);

        if (ast.columns) {
          // Column list specified
          const row = {};
          for (let i = 0; i < ast.columns.length; i++) {
            row[ast.columns[i]] = ast.values[i];
          }
          validateRow(colsDef, row);
          data[tableName].push(row);
        } else {
          // No column list - values must match schema column count
          const vals = ast.values;
          if (vals.length !== colsDef.length) {
            throw new ProgrammingError(
              `Table '${tableName}' has ${colsDef.length} columns but ${vals.length} values provided`
            );
          }
          const row = {};
          for (let i = 0; i < colsDef.length; i++) {
            row[colsDef[i].name] = vals[i];
          }
          data[tableName].push(row);
        }
        this._rowcount = 1;

      } else if (ast.type === 'UPDATE') {
        const tableName = ast.tableName;
        if (!schema[tableName]) {
          throw new IntegrityError(`Table '${tableName}' does not exist`);
        }
        const rows = data[tableName] || [];
        let updateCount = 0;
        for (const row of rows) {
          const matchResult = rowMatchesConditions(row, ast.where, null, 0);
          if (matchResult.result) {
            for (const [colName, val] of ast.setClauses) {
              row[colName] = val;
            }
            updateCount++;
          }
        }
        this._rowcount = updateCount;

      } else if (ast.type === 'DELETE') {
        const tableName = ast.tableName;
        if (!schema[tableName]) {
          throw new IntegrityError(`Table '${tableName}' does not exist`);
        }
        const rows = data[tableName] || [];
        const remaining = [];
        let deleteCount = 0;
        for (const row of rows) {
          const matchResult = rowMatchesConditions(row, ast.where, null, 0);
          if (matchResult.result) {
            deleteCount++;
          } else {
            remaining.push(row);
          }
        }
        data[tableName] = remaining;
        this._rowcount = deleteCount;

      } else if (ast.type === 'SELECT') {
        const tableName = ast.tableName;
        if (!schema[tableName]) {
          throw new IntegrityError(`Table '${tableName}' does not exist`);
        }
        const rows = data[tableName] || [];
        const colsDef = schema[tableName];
        const allColNames = colsDef.map(c => c.name);

        // Determine which columns to select
        let selectedCols;
        if (ast.columns === '*') {
          selectedCols = allColNames;
        } else {
          selectedCols = ast.columns.filter(c => allColNames.indexOf(c) !== -1);
        }

        // Filter rows
        const filtered = [];
        for (const row of rows) {
          const matchResult = rowMatchesConditions(row, ast.where, null, 0);
          if (matchResult.result) {
            filtered.push(row);
          }
        }

        // Build results as array of arrays
        this._results = [];
        for (const row of filtered) {
          const tuple = selectedCols.map(col => {
            return row[col] !== undefined ? row[col] : null;
          });
          this._results.push(tuple);
        }

        // Set description
        this._description = selectedCols.map(col => [col, null, null, null, null, null, null]);
        this._rowcount = this._results.length;
      }

      // Mark database as dirty
      db._dirty = true;
      return this;
    }

    /**
     * Execute a SQL statement against all parameter sequences.
     *
     * @param {string} sql - SQL statement string with %s placeholders.
     * @param {Array} seqOfParams - Array of parameter arrays.
     * @returns {Cursor} self for method chaining.
     */
    executemany(sql, seqOfParams) {
      let totalRows = 0;
      for (const params of seqOfParams) {
        this.execute(sql, params);
        if (this._rowcount > 0) totalRows += this._rowcount;
      }
      this._rowcount = totalRows;
      return this;
    }

    /**
     * Fetch the next row from the result set.
     *
     * @returns {Array|null} A row array, or null if no more rows.
     */
    fetchone() {
      if (this._results === null) {
        throw new ProgrammingError('No results to fetch');
      }
      if (this._results.length === 0) return null;
      return this._results.shift();
    }

    /**
     * Fetch the next set of rows from the result set.
     *
     * @param {number|null} size - Number of rows to fetch (defaults to arraysize).
     * @returns {Array} Array of row arrays.
     */
    fetchmany(size) {
      if (this._results === null) {
        throw new ProgrammingError('No results to fetch');
      }
      if (size === null || size === undefined) size = this._arraysize;
      const fetched = [];
      const count = Math.min(size, this._results.length);
      for (let i = 0; i < count; i++) {
        fetched.push(this._results.shift());
      }
      return fetched;
    }

    /**
     * Fetch all remaining rows from the result set.
     *
     * @returns {Array} Array of row arrays.
     */
    fetchall() {
      if (this._results === null) {
        throw new ProgrammingError('No results to fetch');
      }
      const result = this._results.slice();
      this._results = [];
      return result;
    }

    /**
     * Iterator over all remaining rows.
     *
     * @returns {Iterator} Iterator over row arrays.
     */
    [Symbol.iterator]() {
      return this.fetchall()[Symbol.iterator]();
    }
  }

  // =========================================================================
  // Connection class
  // =========================================================================

  /**
   * A database connection backed by localStorage.
   * Supports commit (write to localStorage), rollback (reload from localStorage),
   * and cursor creation.
   */
  class Connection {
    /**
     * Initialize connection to a database.
     *
     * @param {string} dbName - Name of the database (used as localStorage key prefix).
     */
    constructor(dbName) {
      this._dbName = dbName;
      this._schema = {};
      this._data = {};
      this._dirty = false;
      this._closed = false;
      this._autocommit = false;

      // Load existing database or create empty one
      const loaded = loadDatabase(dbName);
      this._schema = loaded.schema;
      this._data = loaded.data;
    }

    /**
     * Create a new cursor for this connection.
     *
     * @returns {Cursor} A Cursor instance.
     */
    cursor() {
      if (this._closed) throw new OperationalError('Connection is closed');
      return new Cursor(this);
    }

    /**
     * Commit (save) all pending changes to localStorage.
     */
    commit() {
      if (this._closed) throw new OperationalError('Connection is closed');
      saveDatabase(this._dbName, this._schema, this._data);
      this._dirty = false;
    }

    /**
     * Rollback (discard) all pending changes by reloading from localStorage.
     */
    rollback() {
      if (this._closed) throw new OperationalError('Connection is closed');
      const loaded = loadDatabase(this._dbName);
      this._schema = loaded.schema;
      this._data = loaded.data;
      this._dirty = false;
    }

    /**
     * Close the connection. Uncommitted changes are discarded.
     */
    close() {
      if (!this._closed) {
        this._closed = true;
      }
    }

    /**
     * Read-only attribute indicating if the connection is closed.
     * @returns {boolean}
     */
    get closed() {
      return this._closed;
    }

    /**
     * Whether autocommit mode is enabled.
     * @returns {boolean}
     */
    get autocommit() {
      return this._autocommit;
    }

    set autocommit(value) {
      this._autocommit = Boolean(value);
      if (this._autocommit) {
        this.commit();
      }
    }

    /**
     * Get database name.
     * @returns {string}
     */
    get name() {
      return this._dbName;
    }
  }

  // =========================================================================
  // Main JsKiSQL class - Binds to a DOM element and provides SQL interface
  // =========================================================================

  /**
   * JsKiSQL - Main database class that binds to a <div> element.
   *
   * This class provides a complete SQL interface that renders data into
   * a specified DOM element. All data is persisted in localStorage,
   * so it survives page reloads.
   *
   * Usage:
   *   const db = new JsKiSQL('mydb', document.getElementById('output'));
   *   db.execute("CREATE TABLE users (id INTEGER, name TEXT)");
   *   db.execute("INSERT INTO users VALUES (%s, %s)", [1, 'Alice']);
   *   db.commit();
   *   db.query("SELECT * FROM users");
   */
  class JsKiSQL {
    /**
     * @param {string} dbName - Database name (used as localStorage key).
     * @param {HTMLElement} outputElement - The <div> element to render data into.
     */
    constructor(dbName, outputElement) {
      if (!dbName) throw new Error('Database name is required');
      if (!outputElement) throw new Error('Output <div> element is required');

      this._dbName = dbName;
      this._outputElement = outputElement;
      this._connection = new Connection(dbName);
      this._lastResults = null;
      this._lastDescription = null;
      this._transactionActive = false;

      // Render initial state
      this._render();
    }

    /**
     * Get the connection object.
     * @returns {Connection}
     */
    get connection() {
      return this._connection;
    }

    /**
     * Get the database name.
     * @returns {string}
     */
    get name() {
      return this._dbName;
    }

    // =======================================================================
    // SQL Execution
    // =======================================================================

    /**
     * Execute a SQL statement.
     *
     * @param {string} sql - SQL statement with %s placeholders.
     * @param {Array|null} params - Optional parameters.
     * @returns {Cursor} The cursor used for execution.
     */
    execute(sql, params) {
      const cursor = this._connection.cursor();
      cursor.execute(sql, params || null);

      if (cursor.description) {
        this._lastResults = cursor.fetchall();
        this._lastDescription = cursor.description;
      } else {
        this._lastResults = null;
        this._lastDescription = null;
      }

      cursor.close();
      this._render();
      return this;
    }

    /**
     * Execute a SQL statement and display results.
     * Alias for execute().
     *
     * @param {string} sql - SQL statement with %s placeholders.
     * @param {Array|null} params - Optional parameters.
     * @returns {Cursor} The cursor used for execution.
     */
    exec(sql, params) {
      return this.execute(sql, params);
    }

    /**
     * Execute a query (SELECT) and return results.
     *
     * @param {string} sql - SELECT statement with %s placeholders.
     * @param {Array|null} params - Optional parameters.
     * @returns {Array} Array of row arrays.
     */
    query(sql, params) {
      const cursor = this._connection.cursor();
      cursor.execute(sql, params || null);
      const results = cursor.fetchall();
      this._lastResults = results;
      this._lastDescription = cursor.description;
      cursor.close();
      this._render();
      return results;
    }

    /**
     * Execute multiple SQL statements (separated by ;).
     * Note: Only the last statement's results are stored.
     *
     * @param {string} sql - Multiple SQL statements separated by ;.
     * @returns {JsKiSQL} self for chaining.
     */
    executeScript(sql) {
      const statements = sql.split(';').filter(s => s.trim().length > 0);
      for (const stmt of statements) {
        this.execute(stmt.trim());
      }
      return this;
    }

    // =======================================================================
    // Transaction Support
    // =======================================================================

    /**
     * Begin a transaction.
     * @returns {JsKiSQL} self for chaining.
     */
    begin() {
      this._transactionActive = true;
      this._render();
      return this;
    }

    /**
     * Commit (save) all changes to localStorage.
     * @returns {JsKiSQL} self for chaining.
     */
    commit() {
      this._connection.commit();
      this._transactionActive = false;
      this._render();
      return this;
    }

    /**
     * Rollback (undo) all uncommitted changes.
     * @returns {JsKiSQL} self for chaining.
     */
    rollback() {
      this._connection.rollback();
      this._transactionActive = false;
      this._render();
      return this;
    }

    // =======================================================================
    // Data Display & Rendering
    // =======================================================================

    /**
     * Render the current database state and last query results into the
     * bound <div> element.
     */
    _render() {
      if (!this._outputElement) return;

      const container = this._outputElement;
      container.innerHTML = '';

      // Header
      const header = document.createElement('div');
      header.className = 'jskisql-header';
      header.innerHTML = `
        <div class="jskisql-title">
          <strong>JsKiSQL</strong> &mdash; <span class="jskisql-dbname">${this._escapeHtml(this._dbName)}</span>
          ${this._transactionActive ? '<span class="jskisql-txn-badge">TRANSACTION</span>' : ''}
        </div>
        <div class="jskisql-status">
          Tables: ${Object.keys(this._connection._schema).length} |
          ${this._connection._dirty ? 'Unsaved changes' : 'Saved'}
        </div>
      `;
      container.appendChild(header);

      // Render last query results
      if (this._lastResults !== null && this._lastDescription !== null) {
        const resultSection = document.createElement('div');
        resultSection.className = 'jskisql-results';

        const resultTitle = document.createElement('div');
        resultTitle.className = 'jskisql-section-title';
        resultTitle.textContent = `Query Results (${this._lastResults.length} rows)`;
        resultSection.appendChild(resultTitle);

        const table = this._renderTable(this._lastDescription, this._lastResults);
        resultSection.appendChild(table);
        container.appendChild(resultSection);
      }

      // Render all tables
      const schema = this._connection._schema;
      const data = this._connection._data;

      const tableNames = Object.keys(schema);
      if (tableNames.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'jskisql-empty';
        emptyMsg.textContent = 'No tables in database. Use CREATE TABLE to create one.';
        container.appendChild(emptyMsg);
      } else {
        for (const tableName of tableNames) {
          const tableSection = document.createElement('div');
          tableSection.className = 'jskisql-table-section';

          const cols = schema[tableName];
          const rows = data[tableName] || [];

          const tableTitle = document.createElement('div');
          tableTitle.className = 'jskisql-section-title';
          tableTitle.textContent = `Table: ${tableName} (${rows.length} rows, ${cols.length} columns)`;
          tableSection.appendChild(tableTitle);

          // Column info
          const colInfo = document.createElement('div');
          colInfo.className = 'jskisql-col-info';
          colInfo.textContent = cols.map(c =>
            `${c.name} ${c.type}${c.length !== null ? `(${c.length})` : ''}`
          ).join(', ');
          tableSection.appendChild(colInfo);

          // Table data
          if (rows.length > 0) {
            const desc = cols.map(c => [c.name, null, null, null, null, null, null]);
            const dataRows = rows.map(row => cols.map(c => row[c.name] !== undefined ? row[c.name] : null));
            const tbl = this._renderTable(desc, dataRows);
            tableSection.appendChild(tbl);
          } else {
            const emptyRow = document.createElement('div');
            emptyRow.className = 'jskisql-empty-row';
            emptyRow.textContent = '(empty table)';
            tableSection.appendChild(emptyRow);
          }

          container.appendChild(tableSection);
        }
      }

      // Footer
      const footer = document.createElement('div');
      footer.className = 'jskisql-footer';
      footer.textContent = `JsKiSQL v1.0.0 | Data persisted in localStorage`;
      container.appendChild(footer);
    }

    /**
     * Render an HTML table from description and data.
     *
     * @param {Array} description - Column descriptions.
     * @param {Array} dataRows - Array of row arrays.
     * @returns {HTMLElement} Table element.
     */
    _renderTable(description, dataRows) {
      const table = document.createElement('table');
      table.className = 'jskisql-table';

      // Header
      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      for (const col of description) {
        const th = document.createElement('th');
        th.textContent = col[0];
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      // Body
      const tbody = document.createElement('tbody');
      for (const row of dataRows) {
        const tr = document.createElement('tr');
        for (const cell of row) {
          const td = document.createElement('td');
          td.textContent = cell !== null && cell !== undefined ? String(cell) : 'NULL';
          if (cell === null || cell === undefined) {
            td.className = 'jskisql-null';
          }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      return table;
    }

    /**
     * Escape HTML special characters.
     *
     * @param {string} str - Input string.
     * @returns {string} Escaped string.
     */
    _escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    /**
     * Manually refresh the display.
     * @returns {JsKiSQL} self for chaining.
     */
    refresh() {
      this._render();
      return this;
    }

    /**
     * Clear the entire database (all tables and data).
     * @returns {JsKiSQL} self for chaining.
     */
    clear() {
      this._connection._schema = {};
      this._connection._data = {};
      this._connection._dirty = true;
      this._lastResults = null;
      this._lastDescription = null;
      this._render();
      return this;
    }

    /**
     * Drop all tables in the database.
     * @returns {JsKiSQL} self for chaining.
     */
    dropAllTables() {
      const tableNames = Object.keys(this._connection._schema);
      for (const name of tableNames) {
        this.execute(`DROP TABLE ${name}`);
      }
      return this;
    }
  }

  // =========================================================================
  // Auto-load default styles
  // =========================================================================

  /**
   * Inject default CSS styles for JsKiSQL tables.
   */
  function injectStyles() {
    if (typeof document === 'undefined') return;

    const styleId = 'jskisql-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .jskisql-header {
        padding: 10px 12px;
        background: #f0f4f8;
        border: 1px solid #d0d7de;
        border-radius: 6px 6px 0 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        margin-bottom: 0;
      }
      .jskisql-header .jskisql-title {
        font-size: 16px;
        margin-bottom: 4px;
      }
      .jskisql-header .jskisql-dbname {
        color: #0969da;
      }
      .jskisql-header .jskisql-txn-badge {
        display: inline-block;
        background: #ddf4ff;
        color: #0969da;
        border: 1px solid #54aeff;
        border-radius: 12px;
        padding: 1px 8px;
        font-size: 11px;
        margin-left: 8px;
        font-weight: 600;
      }
      .jskisql-header .jskisql-status {
        color: #656d76;
        font-size: 12px;
      }
      .jskisql-results {
        padding: 8px 12px;
        background: #ffffff;
        border-left: 1px solid #d0d7de;
        border-right: 1px solid #d0d7de;
      }
      .jskisql-section-title {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        font-weight: 600;
        color: #24292f;
        padding: 6px 0;
        border-bottom: 1px solid #e8eaed;
        margin-bottom: 6px;
      }
      .jskisql-table-section {
        padding: 8px 12px;
        background: #ffffff;
        border-left: 1px solid #d0d7de;
        border-right: 1px solid #d0d7de;
      }
      .jskisql-col-info {
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 12px;
        color: #656d76;
        padding: 4px 0;
        margin-bottom: 4px;
      }
      .jskisql-table {
        width: 100%;
        border-collapse: collapse;
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 13px;
        margin: 4px 0;
      }
      .jskisql-table th {
        background: #f6f8fa;
        border: 1px solid #d0d7de;
        padding: 6px 10px;
        text-align: left;
        font-weight: 600;
        color: #24292f;
      }
      .jskisql-table td {
        border: 1px solid #d0d7de;
        padding: 5px 10px;
        color: #24292f;
      }
      .jskisql-table tr:nth-child(even) td {
        background: #f6f8fa;
      }
      .jskisql-table td.jskisql-null {
        color: #8b949e;
        font-style: italic;
      }
      .jskisql-empty {
        padding: 20px 12px;
        background: #ffffff;
        border-left: 1px solid #d0d7de;
        border-right: 1px solid #d0d7de;
        color: #656d76;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        text-align: center;
      }
      .jskisql-empty-row {
        padding: 8px 0;
        color: #8b949e;
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 12px;
        font-style: italic;
      }
      .jskisql-footer {
        padding: 8px 12px;
        background: #f6f8fa;
        border: 1px solid #d0d7de;
        border-top: none;
        border-radius: 0 0 6px 6px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 11px;
        color: #656d76;
      }
    `;
    document.head.appendChild(style);
  }

  // Auto-inject styles when loaded in browser
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectStyles);
    } else {
      injectStyles();
    }
  }

  // =========================================================================
  // Exports
  // =========================================================================

  JsKiSQL.Connection = Connection;
  JsKiSQL.Cursor = Cursor;
  JsKiSQL.JsKiSQLError = JsKiSQLError;
  JsKiSQL.DatabaseError = DatabaseError;
  JsKiSQL.OperationalError = OperationalError;
  JsKiSQL.ProgrammingError = ProgrammingError;
  JsKiSQL.IntegrityError = IntegrityError;
  JsKiSQL.NotSupportedError = NotSupportedError;
  JsKiSQL.VERSION = '1.0.0';

  return JsKiSQL;

}));
