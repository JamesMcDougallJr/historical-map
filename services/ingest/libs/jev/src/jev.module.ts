import { Module } from "@nestjs/common";
import { JevClient } from "./jev.client";

@Module({
  providers: [JevClient],
  exports: [JevClient],
})
export class JevModule {}
