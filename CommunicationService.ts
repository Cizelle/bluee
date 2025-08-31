import {
  BleManager,
  Device,
  State,
} from 'react-native-ble-plx';
import { NativeModules, NativeEventEmitter, Platform, PermissionsAndroid } from 'react-native';
import { DisasterData } from './realm';
import BackgroundJob from 'react-native-background-actions';
import Beacons from 'react-native-beacons-manager';
import { Buffer } from 'buffer';
import Realm from 'realm';

const { BeaconsManager } = NativeModules;
const beaconsEmitter = new NativeEventEmitter(BeaconsManager);

// --- Placeholder for custom BLE Service and Characteristic UUIDs ---
const SERVICE_UUID = '4A13A000-8A7E-46C9-809D-1E060417E45C';
const CHARACTERISTIC_UUID = '4A13A001-8A7E-46C9-809D-1E060417E45C';
const DATA_CHARACTERISTIC_UUID = '4A13A002-8A7E-46C9-809D-1E060417E45C';

// --- Beacon UUIDs ---
const BEACON_UUID = 'B9407F30-F5F8-466E-AFF9-25556B57FE6D';
const REGION_ID = 'MyBeaconRegion';

const taskOptions = {
  taskName: 'DisasterCommunication',
  taskTitle: 'Offline Communication Active',
  taskDesc: 'Sending and receiving data for disaster management.',
  taskIcon: {
    name: 'ic_launcher',
    type: 'mipmap',
  },
  linkingURI: 'disasterapp://',
  parameters: {
    delay: 5000,
  },
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(() => resolve(), ms));
class CommunicationService {
  private manager: BleManager;
  private localRealm: Realm | null = null;
  private deviceData: any | null = null;
  private isScanning = false;
  private beaconSubscription: any | null = null;

  constructor() {
    this.manager = new BleManager();
    this.manager.onStateChange(this.handleBleStateChange, true);
  }

  private handleBleStateChange = (state: State) => {
    console.log('Bluetooth state changed:', state);
  };

  public updateDeviceData(data: any) {
    this.deviceData = data;
    if (this.localRealm && !this.localRealm.isClosed) {
      this.localRealm.write(() => {
        const existingData = this.localRealm!.objectForPrimaryKey('DisasterData', data._id);
        if (!existingData) {
          this.localRealm!.create('DisasterData', data);
        }
      });
    }
  }

  public startBackgroundCommunication() {
    console.log('Starting background communication service.');

    const backgroundTask = async (taskData: any) => {
      // --- Fix 2: Open a new Realm instance inside background task ---
      let bgRealm: Realm | null = null;
      try {
        bgRealm = await Realm.open({
          schema: [DisasterDataSchema],
          path: 'disaster.realm', // Match your app's Realm path if it's different
        });
      } catch (e) {
        console.error('Failed to open Realm in background task', e);
        return;
      }

      const loop = async () => {
        // --- Fix 6: Use a proper loop with isRunning() check ---
        while (BackgroundJob.isRunning()) {
          try {
            console.log('Running gossip loop...');
            // Check Bluetooth state before scanning
            const state = await this.manager.state();
            if (state === 'PoweredOn') {
              this.startBleCommunication(bgRealm!);
              this.startBeaconCommunication(bgRealm!);
            } else {
              console.warn('Bluetooth is not powered on. Waiting...');
            }
          } catch (e) {
            console.error('Background loop error:', e);
          }
          await sleep(taskData.delay || 10000);
        }
      };

      try {
        await loop();
      } finally {
        if (bgRealm && !bgRealm.isClosed) {
          bgRealm.close();
        }
      }
    };

    BackgroundJob.start(backgroundTask, taskOptions);
  }

  public stopBackgroundCommunication() {
    console.log('Stopping background communication service.');
    BackgroundJob.stop();

    if (this.manager) {
      this.manager.stopDeviceScan();
      this.isScanning = false;
    }

    // --- Fix 4: Remove listener on stop ---
    if (this.beaconSubscription) {
      this.beaconSubscription.remove();
      this.beaconSubscription = null;
    }
    Beacons.stopRangingBeaconsInRegion(REGION_ID, BEACON_UUID);
  }

  private async startBeaconCommunication(bgRealm: Realm) {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          {
            title: 'Location Permission',
            message: 'This app needs access to your location to scan for beacons.',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          },
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          console.log('Location permission denied for beacons.');
          return;
        }
      }

      Beacons.startRangingBeaconsInRegion(REGION_ID, BEACON_UUID);

      // --- Fix 4: Add listener only once ---
      if (!this.beaconSubscription) {
        this.beaconSubscription = beaconsEmitter.addListener('beaconsDidRange', (data: any) => {
          console.log('Beacons found:', data.beacons);
        });
      }
    } catch (error) {
      console.error('Error with Beacon communication:', error);
    }
  }

  private async startBleCommunication(bgRealm: Realm) {
    if (this.isScanning) {
      return;
    }
    this.isScanning = true;

    try {
      this.manager.startDeviceScan(
        [SERVICE_UUID],
        { allowDuplicates: false },
        (error, device) => {
          if (error) {
            console.error('BLE Scan error:', error.message);
            this.isScanning = false;
            return;
          }
          if (device && device.name) {
            console.log(`Found BLE device: ${device.name}`);
            this.manager.stopDeviceScan();
            this.isScanning = false;
            this.connectToDevice(device, bgRealm);
          }
        },
      );
    } catch (error) {
      console.error('An error occurred during startDeviceScan:', error);
      this.isScanning = false;
    }
  }

  private async connectToDevice(device: Device, bgRealm: Realm) {
    console.log(`Attempting to connect to ${device.id}...`);
    try {
      const connectedDevice = await device.connect();
      await connectedDevice.discoverAllServicesAndCharacteristics();
      console.log(`Connected and discovered services for ${connectedDevice.id}`);

      const localDataSummary = this.generateDataSummary(bgRealm);
      const localSummaryBase64 = Buffer.from(JSON.stringify(localDataSummary)).toString('base64');
      const summaryCharacteristic = await connectedDevice.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        localSummaryBase64,
      );

      const remoteDataSummaryBase64 = summaryCharacteristic.value;
      if (!remoteDataSummaryBase64) {
        throw new Error('Did not receive a summary from the remote device.');
      }
      const remoteDataSummary = JSON.parse(Buffer.from(remoteDataSummaryBase64, 'base64').toString('utf8'));
      console.log('Received remote data summary:', remoteDataSummary);

      const myMissingRecordsToSend = this.getMissingDataFromRemote(remoteDataSummary, bgRealm);
      if (myMissingRecordsToSend.length > 0) {
        console.log(`Sending ${myMissingRecordsToSend.length} records to remote device.`);
        const dataToSendBase64 = Buffer.from(JSON.stringify(myMissingRecordsToSend)).toString('base64');
        await connectedDevice.writeCharacteristicWithResponseForService(
          SERVICE_UUID,
          DATA_CHARACTERISTIC_UUID,
          dataToSendBase64,
        );
      }

      const remoteCharacteristic = await connectedDevice.readCharacteristicForService(
        SERVICE_UUID,
        DATA_CHARACTERISTIC_UUID,
      );

      const receivedDataFromRemoteBase64 = remoteCharacteristic.value;
      if (receivedDataFromRemoteBase64) {
        const receivedDataFromRemote = JSON.parse(Buffer.from(receivedDataFromRemoteBase64, 'base64').toString('utf8'));
        console.log(`Received ${receivedDataFromRemote.length} new records from remote device.`);
        receivedDataFromRemote.forEach((record: any) => {
          this.handleReceivedData(record, bgRealm);
        });
      }
    } catch (error) {
      console.error('Gossip protocol connection failed:', error);
    } finally {
      console.log('Attempting to disconnect...');
      await device.cancelConnection();
      console.log('Disconnected from device. Restarting scan.');
      this.isScanning = false;
      this.startBleCommunication(bgRealm);
    }
  }

  private handleReceivedData(receivedData: any, bgRealm: Realm) {
    if (!receivedData || !receivedData.deviceId || bgRealm.isClosed) {
      return;
    }
    try {
      bgRealm.write(() => {
        const existingData = bgRealm!.objectForPrimaryKey('DisasterData', receivedData._id);
        if (!existingData) {
          bgRealm!.create('DisasterData', receivedData);
        }
      });
    } catch (err) {
      console.error('Realm write error', err);
    }
  }

  private generateDataSummary(bgRealm: Realm) {
    const data = bgRealm.objects<DisasterData>('DisasterData');
    const summary: Record<string, { timestamp: Date }> = {};
    data.forEach(record => {
      const { deviceId, timestamp } = record;
      if (!summary[deviceId] || new Date(timestamp) > summary[deviceId].timestamp) {
        summary[deviceId] = {
          timestamp: new Date(timestamp),
        };
      }
    });
    return summary;
  }

  private getMissingDataFromRemote(remoteSummary: any, bgRealm: Realm): DisasterData[] {
    const myData = bgRealm.objects<DisasterData>('DisasterData');
    const recordsToSend: DisasterData[] = [];

    myData.forEach(record => {
      if (!remoteSummary[record.deviceId]
        || new Date(remoteSummary[record.deviceId].timestamp) < record.timestamp) {
        recordsToSend.push(record);
      }
    });
    return recordsToSend;
  }
}

let communicationServiceInstance: CommunicationService | null = null;
export const getCommunicationService = () => {
  if (!communicationServiceInstance) {
    communicationServiceInstance = new CommunicationService();
  }
  return communicationServiceInstance;
};