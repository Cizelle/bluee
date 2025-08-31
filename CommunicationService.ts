import {
  BleManager,
  Device,
} from 'react-native-ble-plx';
import { NativeModules, NativeEventEmitter, Platform, PermissionsAndroid } from 'react-native';
import { DisasterData } from './realm';
import BackgroundJob from 'react-native-background-actions';
import Beacons from 'react-native-beacons-manager';
import { Buffer } from 'buffer';

const { BeaconsManager } = NativeModules;
const beaconsEmitter = new NativeEventEmitter(BeaconsManager);

// --- Placeholder for custom BLE Service and Characteristic UUIDs ---
const SERVICE_UUID = '4A13A000-8A7E-46C9-809D-1E060417E45C';
const CHARACTERISTIC_UUID = '4A13A001-8A7E-46C9-809D-1E060417E45C';
const DATA_CHARACTERISTIC_UUID = '4A13A002-8A7E-46C9-809D-1E060417E45C';

// --- Beacon UUIDs ---
const BEACON_UUID = 'B9407F30-F5F8-466E-AFF9-25556B57FE6D';
const REGION_ID = 'MyBeaconRegion';

// Task options for background service
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

class CommunicationService {
  private manager: BleManager;
  private localRealm: Realm | null = null;
  private deviceData: any | null = null;
  private isScanning = false;

  constructor() {
    this.manager = new BleManager();
    this.manager.onStateChange(state => {
      console.log('Bluetooth state changed:', state);
    }, true);
  }

  public updateDeviceData(data: any) {
    this.deviceData = data;
    if (this.localRealm) {
      this.localRealm.write(() => {
        const existingData = this.localRealm!.objectForPrimaryKey('DisasterData', data._id);
        if (!existingData) {
          this.localRealm!.create('DisasterData', data);
        }
      });
    }
  }

  public startBackgroundCommunication(realmInstance: Realm) {
    this.localRealm = realmInstance;
    console.log('Starting background communication service.');

    const backgroundTask = async (taskData: any) => {
      setInterval(() => {
        console.log('Running gossip loop...');
        this.checkAndStartBleScan(); // Call the new, safer method
        this.startBeaconCommunication();
      }, 10000);

      await new Promise(async () => {
        // Keep the task alive
      });
    };

    BackgroundJob.start(backgroundTask, taskOptions);
  }

  public stopBackgroundCommunication() {
    console.log('Stopping background communication service.');
    BackgroundJob.stop();

    if (this.manager) {
      if (this.isScanning) {
        this.manager.stopDeviceScan();
        this.isScanning = false;
      }
    }

    Beacons.stopRangingBeaconsInRegion(REGION_ID, BEACON_UUID);
  }

  private async startBeaconCommunication() {
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

      beaconsEmitter.addListener('beaconsDidRange', (data: any) => {
        console.log('Beacons found:', data.beacons);
      });
    } catch (error) {
      console.error('Error with Beacon communication:', error);
    }
  }

  // --- New, safer method to check and start BLE scan ---
  private async checkAndStartBleScan() {
    try {
      const state = await this.manager.state();
      if (state !== 'PoweredOn') {
        console.warn('Bluetooth is not powered on. Cannot start scan.');
        return;
      }

      if (this.isScanning) {
        return;
      }

      this.isScanning = true;
      
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
            this.connectToDevice(device);
          }
        },
      );
    } catch (error) {
      console.error('Error checking Bluetooth state:', error);
    }
  }

  private async connectToDevice(device: Device) {
    console.log(`Attempting to connect to ${device.id}...`);
    try {
      const connectedDevice = await device.connect();
      await connectedDevice.discoverAllServicesAndCharacteristics();

      const localDataSummary = this.generateDataSummary();
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

      const myMissingRecordsToSend = this.getMissingDataFromRemote(remoteDataSummary);
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
          this.handleReceivedData(record);
        });
      }
    } catch (error) {
      console.error('Gossip protocol connection failed:', error);
    } finally {
      await device.cancelConnection();
      console.log('Disconnected from device. Restarting scan.');
      this.isScanning = false;
      this.checkAndStartBleScan();
    }
  }

  private handleReceivedData(receivedData: any) {
    if (!receivedData || !receivedData.deviceId || !this.localRealm) {
      return;
    }
    this.localRealm.write(() => {
      const existingData = this.localRealm!.objectForPrimaryKey('DisasterData', receivedData._id);
      if (!existingData) {
        this.localRealm!.create('DisasterData', receivedData);
      }
    });
  }

  private generateDataSummary() {
    const data = this.localRealm!.objects<DisasterData>('DisasterData');
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

  private getMissingDataFromRemote(remoteSummary: any): DisasterData[] {
    const myData = this.localRealm!.objects<DisasterData>('DisasterData');
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
export const getCommunicationService = (realmInstance: Realm) => {
  if (!communicationServiceInstance) {
    communicationServiceInstance = new CommunicationService();
  }
  return communicationServiceInstance;
};