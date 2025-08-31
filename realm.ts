import {Realm, createRealmContext} from '@realm/react';

// Define the schema for the data we will be storing
export class DisasterData extends Realm.Object {
  _id!: Realm.BSON.ObjectId;
  deviceId!: string;
  latitude!: number;
  longitude!: number;
  batteryLevel!: string;
  batteryState!: string;
  timestamp!: Date;

  static generate(data: {
    deviceId: string;
    latitude: number;
    longitude: number;
    batteryLevel: string;
    batteryState: string;
  }) {
    return {
      _id: new Realm.BSON.ObjectId(),
      deviceId: data.deviceId,
      latitude: data.latitude,
      longitude: data.longitude,
      batteryLevel: data.batteryLevel,
      batteryState: data.batteryState,
      timestamp: new Date(),
    };
  }

  static schema = {
    name: 'DisasterData',
    primaryKey: '_id',
    properties: {
      _id: 'objectId',
      deviceId: 'string',
      latitude: 'double',
      longitude: 'double',
      batteryLevel: 'string',
      batteryState: 'string',
      timestamp: 'date',
    },
  };
}

// Create a Realm context to use in our React components
export const RealmContext = createRealmContext({
  schema: [DisasterData],
});