'use strict';

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:               process.env.DB_HOST,
  port:               parseInt(process.env.DB_PORT) || 3306,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASS,
  database:           process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
  timezone:           '+00:00',
});

async function initDB() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS services (
      id         VARCHAR(36)  PRIMARY KEY,
      name       VARCHAR(255) NOT NULL,
      url        TEXT         NOT NULL,
      category   VARCHAR(100) NOT NULL DEFAULT 'General',
      tags       TEXT         NOT NULL DEFAULT '[]',
      position   INT          NOT NULL DEFAULT 0,
      created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Add position to existing tables that predate this column
  await pool.execute(`ALTER TABLE services ADD COLUMN IF NOT EXISTS position INT NOT NULL DEFAULT 0`).catch(() => {});
  await pool.execute(`ALTER TABLE services ADD COLUMN IF NOT EXISTS maintenance_until DATETIME NULL DEFAULT NULL`).catch(() => {});
  await pool.execute(`ALTER TABLE services ADD COLUMN IF NOT EXISTS rt_threshold INT NULL DEFAULT NULL`).catch(() => {});
  // Seed position from created_at order (only rows where position is still 0)
  await pool.execute(`
    UPDATE services s
    JOIN (
      SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) - 1 AS rn
      FROM services
    ) ranked ON ranked.id = s.id
    SET s.position = ranked.rn
    WHERE s.position = 0
  `).catch(() => {});

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS history (
      id            INT         AUTO_INCREMENT PRIMARY KEY,
      service_id    VARCHAR(36) NOT NULL,
      status        VARCHAR(20) NOT NULL,
      response_time INT         DEFAULT NULL,
      status_code   INT         DEFAULT NULL,
      checked_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sid (service_id),
      INDEX idx_ts  (checked_at),
      CONSTRAINT fk_svc FOREIGN KEY (service_id)
        REFERENCES services(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS requests (
      id          VARCHAR(36)  PRIMARY KEY,
      url         TEXT         NOT NULL,
      name        VARCHAR(255) NOT NULL,
      service_type VARCHAR(60) NOT NULL DEFAULT 'Website',
      category    VARCHAR(100) NOT NULL DEFAULT 'General',
      description TEXT,
      discord_id  VARCHAR(100),
      contact     VARCHAR(255),
      priority    VARCHAR(20)  NOT NULL DEFAULT 'normal',
      notify_down TINYINT(1)   NOT NULL DEFAULT 1,
      notify_recover TINYINT(1) NOT NULL DEFAULT 1,
      notes       TEXT,
      status      VARCHAR(20)  NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS incidents (
      id         VARCHAR(36)  PRIMARY KEY,
      title      VARCHAR(255) NOT NULL,
      body       TEXT,
      severity   VARCHAR(20)  NOT NULL DEFAULT 'minor',
      status     VARCHAR(20)  NOT NULL DEFAULT 'active',
      created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP   NULL DEFAULT NULL
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id         VARCHAR(36)  PRIMARY KEY,
      email      VARCHAR(255) NOT NULL UNIQUE,
      token      VARCHAR(64)  NOT NULL,
      confirmed  TINYINT(1)   NOT NULL DEFAULT 0,
      created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS webhook_subscribers (
      id         VARCHAR(36)  PRIMARY KEY,
      url        TEXT         NOT NULL,
      created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('[db] tables ready');
}

module.exports = { pool, initDB };
