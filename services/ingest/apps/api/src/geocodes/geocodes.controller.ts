import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import {
  JEV_CONTEXT_GEOCODE,
  getConfidenceThreshold,
  listGeocodeReviews,
  reviewGeocode,
  setConfidenceThreshold,
  type GeocodeReviewAction,
} from "@app/database";
import { normalizePlaceName } from "@app/geocoding";
import type { GeocodeReviewItem } from "@historical-map/domain";

/**
 * Geocodes a model decided, and the verbs to overrule them, plus the
 * threshold those decisions are held to.
 *
 * These **write** — a rejection takes events off the map — so the module
 * mounts them behind the same fail-closed Basic auth as `/duplicates`. The
 * logic is `@app/database`'s, shared with `npm run geocode:review`.
 */
@Controller("geocodes")
export class GeocodesController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async list(): Promise<{ data: GeocodeReviewItem[]; threshold: number }> {
    return {
      data: await listGeocodeReviews(this.dataSource, normalizePlaceName),
      threshold: await getConfidenceThreshold(this.dataSource, JEV_CONTEXT_GEOCODE, 0.8),
    };
  }

  @Put("threshold")
  async threshold(@Body() body: { minConfidence?: number }): Promise<{ ok: true }> {
    const result = await setConfidenceThreshold(
      this.dataSource,
      JEV_CONTEXT_GEOCODE,
      Number(body?.minConfidence),
    );
    if (!result.ok) throw new BadRequestException(result.reason);
    return { ok: true };
  }

  @Post(":id/confirm")
  confirm(@Param("id") id: string): Promise<{ ok: true; demoted: number }> {
    return this.review(id, "confirm");
  }

  @Post(":id/reject")
  reject(@Param("id") id: string): Promise<{ ok: true; demoted: number }> {
    return this.review(id, "reject");
  }

  private async review(
    id: string,
    action: GeocodeReviewAction,
  ): Promise<{ ok: true; demoted: number }> {
    const result = await this.dataSource.transaction((tx) =>
      reviewGeocode(tx, id, action, normalizePlaceName),
    );
    if (!result.ok) {
      throw result.reason.startsWith("No geocode")
        ? new NotFoundException(result.reason)
        : new BadRequestException(result.reason);
    }
    return { ok: true, demoted: result.demoted };
  }
}
