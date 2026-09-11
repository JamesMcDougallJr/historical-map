import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { SourceAdapter } from "@historical-map/domain";
import { LocalDirectoryAdapter } from "./adapters/local-directory.adapter";
import { SOURCE_ADAPTERS } from "./tokens";

/**
 * **Adding a source is a new adapter file plus one line in this array.**
 *
 * Nothing downstream may branch on which source a document came from — not the
 * detect worker, not the queue contracts, not the API. If a change requires
 * orchestration code to know the difference between two sources, the
 * abstraction has leaked and the change is wrong, even when the branch would be
 * smaller than the adapter.
 */
@Module({
  providers: [
    {
      provide: SOURCE_ADAPTERS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SourceAdapter[] => [
        new LocalDirectoryAdapter(
          config.get<string>("INGEST_CORPUS_DIR") ?? "./corpus",
        ),
      ],
    },
  ],
  exports: [SOURCE_ADAPTERS],
})
export class SourcesModule {}
