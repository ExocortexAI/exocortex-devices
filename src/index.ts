// @exocortex/devices: one contract for any body device, health source or custom sensor, and what implements it.
export type * from './contract.ts';
export * from './health.ts';
export { appleHealthDriver, appleHealthDescriptor } from './drivers/apple-health.ts';
export { healthConnectDriver, healthConnectDescriptor } from './drivers/health-connect.ts';

export { builtinDrivers, driverFor, register } from './registry.ts';
export { catalog, builtinDescriptors, compatibility, routeWorksOn, searchCatalog } from './catalog.ts';
export type { CatalogHit, Compatibility } from './catalog.ts';
export {
  MANIFEST_FORMAT, MANIFEST_LIMITS, BYTE_FORMATS, validateManifest, driverFromManifest, descriptorFromManifest,
} from './manifest.ts';
export type { Manifest, ManifestDescriptor, ManifestDriver, SerialLinesDriver, BleGattDriver, CsvFileDriver, ByteFormat } from './manifest.ts';
export { regionOf, groupByRegion, bandPowers, relativeBandPowers, BANDS, REGIONS } from './eeg.ts';
export type { Band, Region } from './eeg.ts';

export { requestSerial, serialTransport, webSerialSupported } from './transports/web-serial.ts';
export { requestGatt, gattTransport, webBluetoothSupported } from './transports/web-bluetooth.ts';
export { MemoryByteTransport, MemoryGattTransport, memoryContext, memoryFile } from './transports/memory.ts';

export {
  openbciCyton, makeCytonDriver, CytonParser, encodeCytonPacket, readBanner, cytonDescriptor, CYTON_NAMES, CYTON_DAISY_NAMES, uvPerCount,
} from './drivers/openbci-cyton.ts';
export { openbciCytonDaisy } from './drivers/openbci-cyton-daisy.ts';
export { openbciGanglion, GanglionDecoder, encodeGanglionDeltas, ganglionDescriptor } from './drivers/openbci-ganglion.ts';
export { bleHeartRate, parseHeartRate, bleHeartRateDescriptor } from './drivers/ble-heart-rate.ts';
export { polarH10, parsePmdFrame, parsePmdResponse, polarH10Descriptor } from './drivers/polar-h10.ts';
export { edf, readEdf, edfDescriptor } from './drivers/edf.ts';
export { fit, readFit, fitDescriptor } from './drivers/fit.ts';
export { gpx, readGpx, gpxDescriptor } from './drivers/gpx.ts';
export { appleHealthExport, readHealthExport, parseHealthDate, appleHealthExportDescriptor } from './drivers/apple-health-export.ts';
export { csv, readCsv, csvFields, csvDescriptor } from './drivers/csv.ts';
export { exocortexCapDescriptor } from './drivers/exocortex-cap.ts';
export { fileFrom, stableId, uuid } from './util.ts';

export {
  simulatorFor, simulatorSettings, hasSimulator, SIMULATED_DRIVERS, SIM_SETTINGS, simOptions,
  simulateCyton, simulateGanglion, simulateHeartRate, simulatePolarH10, simulateHealthStore, EegModel, HeartModel, ecgAt,
} from './sim/index.ts';
export type { SimOptions, Simulator, HealthSimOptions } from './sim/index.ts';
