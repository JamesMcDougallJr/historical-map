import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { GeocodeCache } from "@app/database";
import { GEOCODER } from "./geocoder.interface";
import { GeocodingService } from "./geocoding.service";
import { NominatimGeocoder } from "./nominatim.geocoder";

/**
 * Binds the token to Nominatim. Swapping in a gazetteer with historical
 * coverage — which is the real fix for 19th-century place names — is this one
 * line, with no change to `PublishingService`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([GeocodeCache])],
  providers: [
    { provide: GEOCODER, useClass: NominatimGeocoder },
    GeocodingService,
  ],
  exports: [GeocodingService],
})
export class GeocodingModule {}
