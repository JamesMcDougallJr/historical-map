import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

/** Liveness probe for `GET /health`. Cheapest query that proves a round trip. */
@Injectable()
export class DatabaseHealthService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async isHealthy(): Promise<boolean> {
    try {
      await this.dataSource.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}
