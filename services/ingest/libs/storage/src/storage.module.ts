import { Module } from "@nestjs/common";
import { S3StorageService } from "./s3-storage.service";
import { STORAGE_SERVICE } from "./storage-service.interface";

/**
 * Binds the token to the S3 implementation. Exports the **token**, never the
 * class, so nothing downstream can depend on S3 specifically.
 */
@Module({
  providers: [{ provide: STORAGE_SERVICE, useClass: S3StorageService }],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
