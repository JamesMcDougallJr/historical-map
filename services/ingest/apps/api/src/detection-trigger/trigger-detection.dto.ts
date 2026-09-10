import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class TriggerDetectionDto {
  /** Omit to fan out one job per enabled source. */
  @IsOptional()
  @IsString()
  sourceKey?: string;

  /** Widen the window for a one-off backfill without changing configuration. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  lookbackDays?: number;
}
