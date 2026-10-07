import pg from "pg";
import { config } from "../config.js";
import { getConnectionString } from "../lib/connectionString.js";

export const pool = new pg.Pool({
  connectionString: getConnectionString(config.databaseUrl),
  max: 5,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});
