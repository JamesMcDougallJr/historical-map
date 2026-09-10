import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DatabaseHealthService } from "./database.service";

/**
 * TypeORM owns both the entities and the migrations for the `ingest_*` tables.
 *
 * `synchronize: false` is not negotiable and is set only here. It is the single
 * most dangerous TypeORM setting — it silently drops columns to make the
 * database match the entities. Migrations are the only thing that changes
 * schema, in every environment including local dev.
 *
 * Note this database is shared with the web app, which owns the map tables
 * (`sources`/`locations`/`events`) through its own `ensureSchema()`. The
 * boundary is at the table level: TypeORM must never be pointed at those.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres" as const,
        url: config.get<string>("POSTGRES_URL"),
        // Filled in by phase 3. Explicit list rather than autoLoadEntities so
        // what this connection can touch is readable in one place.
        entities: [],
        migrations: [],
        synchronize: false,
        autoLoadEntities: false,
      }),
    }),
  ],
  providers: [DatabaseHealthService],
  exports: [DatabaseHealthService],
})
export class DatabaseModule {}
