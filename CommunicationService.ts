import {
  BleManager,
  Device,
  State,
} from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import Realm from 'realm';
import { DisasterData } from './realm';

// --- Placeholder for custom BLE Service and Characteristic UUIDs ---
const SERVICE_UUID = '4A13A000-8A7E-46C9-809D-1E060417E45C';
const CHARACTERISTIC_UUID = '4A13A001-8A7E-46C9-809D-1E060417E45C';
const DATA_CHARACTERISTIC_UUID = '4A13A002-8A7E-46C9-809D-1E060417E45C';

class CommunicationService {
  private manager: BleManager;
  private isScanning = false;

  constructor() {
    this.manager = new BleManager();
    this.manager.onStateChange(this.handleBleStateChange, true);
  }

  private handleBleStateChange = (state: State) => {
    console.log('Bluetooth state changed:', state);
  };

  public updateDeviceData(data: any) {
    // This function will still be used by your App.tsx to store data
  }

  // New function to start a one-time communication
  public startCommunication(realm: Realm) {
    console.log('Starting Bluetooth communication.');
    this.startBleCommunication(realm);
  }

  private async startBleCommunication(realm: Realm) {
    if (this.isScanning) {
      console.log('Scan already in progress.');
      return;
    }
    this.isScanning = true;
    console.log('Starting device scan...');

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
            console.log(`Found BLE device: ${device.name}. Stopping scan...`);
            this.manager.stopDeviceScan();
            this.isScanning = false;
            this.connectToDevice(device, realm);
          }
        },
      );
    } catch (error) {
      console.error('An error occurred during startDeviceScan:', error);
      this.isScanning = false;
    }
  }

  private async connectToDevice(device: Device, realm: Realm) {
    console.log(`Attempting to connect to ${device.id}...`);
    try {
      const connectedDevice = await device.connect();
      await connectedDevice.discoverAllServicesAndCharacteristics();
      console.log(`Connected and discovered services for ${connectedDevice.id}`);

      const localDataSummary = this.generateDataSummary(realm);
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

      const myMissingRecordsToSend = this.getMissingDataFromRemote(remoteDataSummary, realm);
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
          this.handleReceivedData(record, realm);
        });
      }
    } catch (error) {
      console.error('Gossip protocol connection failed:', error);
    } finally {
      console.log('Attempting to disconnect...');
      await device.cancelConnection();
      console.log('Disconnected from device. Communication session complete.');
      this.isScanning = false; // Reset for a new session
    }
  }

  private handleReceivedData(receivedData: any, realm: Realm) {
    if (!receivedData || !receivedData.deviceId || realm.isClosed) {
      return;
    }
    try {
      realm.write(() => {
        const existingData = realm!.objectForPrimaryKey('DisasterData', receivedData._id);
        if (!existingData) {
          realm!.create('DisasterData', receivedData);
        }
      });
    } catch (err) {
      console.error('Realm write error', err);
    }
  }

  private generateDataSummary(realm: Realm) {
    const data = realm.objects<DisasterData>('DisasterData');
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

  private getMissingDataFromRemote(remoteSummary: any, realm: Realm): DisasterData[] {
    const myData = realm.objects<DisasterData>('DisasterData');
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