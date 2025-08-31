import React, {useEffect, useState, useCallback} from 'react';
import {
  SafeAreaView,
  StyleSheet,
  Text,
  View,
  PermissionsAndroid,
  Platform,
  Alert,
} from 'react-native';

// --- Import the libraries we installed ---
import Geolocation from 'react-native-geolocation-service';
import DeviceInfo from 'react-native-device-info';
import {
  getBatteryLevel,
  isCharging,
} from 'react-native-device-battery';
import {getCommunicationService} from './CommunicationService';

// --- Import our new files ---
import {RealmContext, DisasterData} from './realm';
import Realm from 'realm';

// Extract the Realm hooks for use in a child component
const {RealmProvider, useRealm, useQuery} = RealmContext;

// --- Define Types for our State Variables ---
interface GpsLocation {
  latitude: number;
  longitude: number;
}

interface BatteryStatus {
  level: string;
  state: 'full' | 'charging' | 'unplugged';
}

const AppContent = () => {
  const [gpsLocation, setGpsLocation] = useState<GpsLocation | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [batteryStatus, setBatteryStatus] = useState<BatteryStatus | null>(null);
  const [permissionGranted, setPermissionGranted] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('Awaiting data...');
  const [isServiceRunning, setIsServiceRunning] = useState(false);

  const realm = useRealm();
  const storedData = useQuery<DisasterData>('DisasterData');
  const comms = getCommunicationService(realm);

  // In your App.js, modify the requestLocationPermission function
const requestLocationPermission = async () => {
    if (Platform.OS === 'android') {
      try {
        const granted = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]);

        if (granted['android.permission.ACCESS_FINE_LOCATION'] === PermissionsAndroid.RESULTS.GRANTED &&
            granted['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED &&
            granted['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED) {
            console.log('All permissions granted');
            setPermissionGranted(true);
        } else {
            console.log('One or more permissions denied');
            setPermissionGranted(false);
            Alert.alert(
                'Permission Denied',
                'Location and Bluetooth permissions are required to use this app.',
            );
        }
      } catch (err) {
        console.warn(err);
      }
    } else {
      setPermissionGranted(true);
    }
};

  const getDeviceLocation = useCallback(() => {
    if (!permissionGranted) {
      setStatusMessage('Location permission not granted. Cannot retrieve GPS.');
      return;
    }
    Geolocation.watchPosition(
      position => {
        const {latitude, longitude} = position.coords;
        setGpsLocation({latitude, longitude});
        console.log('New GPS Location:', {latitude, longitude});
        setStatusMessage('GPS Location received.');
      },
      error => {
        console.log(error.code, error.message);
        setStatusMessage('Error getting GPS location.');
      },
      // Fixed: Removed 'maximumAge'
      {enableHighAccuracy: true},
    );
  }, [permissionGranted]);

  const getDeviceId = async () => {
    const uniqueId = await DeviceInfo.getUniqueId();
    setDeviceId(uniqueId);
    console.log('Device ID:', uniqueId);
  };

 const getDeviceBattery = () => {
  try {
    const dummyLevel = 0.30; // 30%
    const dummyCharging = false;

    const state = dummyCharging ? 'charging' : 'unplugged';

    setBatteryStatus({  
      level: `${(dummyLevel * 100).toFixed(0)}%`,
      state: state as 'full' | 'charging' | 'unplugged',
    });

    console.log('Using dummy Battery Status:', {
      level: dummyLevel,
      state: state,
    });
  } catch (error) {
    // This catch block won't be hit with the dummy data, but it's good practice to keep.
    console.error('Error getting dummy battery status:', error);
    setStatusMessage('Error getting dummy battery status.');
  }
};

  const startCommsService = useCallback(() => {
    if (!gpsLocation || !deviceId || !batteryStatus) {
      setStatusMessage('Waiting for all device data to be available...');
      return;
    }

    const collectedData = {
      _id: new Realm.BSON.ObjectId(),
      deviceId: deviceId,
      latitude: gpsLocation.latitude,
      longitude: gpsLocation.longitude,
      batteryLevel: batteryStatus.level,
      batteryState: batteryStatus.state,
      timestamp: new Date(),
    };
    
    comms.updateDeviceData(collectedData as DisasterData);
    comms.startBackgroundCommunication(realm);
    setIsServiceRunning(true);
    setStatusMessage('Background communication service started.');
  }, [gpsLocation, deviceId, batteryStatus, comms, realm]);

  useEffect(() => {
    requestLocationPermission();
    getDeviceId();
    getDeviceBattery();

    const dataInterval = setInterval(() => {
      getDeviceBattery();
      getDeviceId();
    }, 60000);

    return () => clearInterval(dataInterval);
  }, []);

  useEffect(() => {
    if (gpsLocation && deviceId && batteryStatus && !isServiceRunning) {
      startCommsService();
    }
  }, [gpsLocation, deviceId, batteryStatus, isServiceRunning, startCommsService]);
  
  useEffect(() => {
    if (permissionGranted) {
      getDeviceLocation();
    }
  }, [permissionGranted, getDeviceLocation]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Disaster Management App</Text>
        <Text style={styles.subtitle}>{statusMessage}</Text>
      </View>

      <View style={styles.dataContainer}>
        <View style={styles.dataCard}>
          <Text style={styles.cardTitle}>GPS Location</Text>
          {gpsLocation ? (
            <>
              <Text style={styles.dataText}>Latitude: {gpsLocation.latitude.toFixed(6)}</Text>
              <Text style={styles.dataText}>Longitude: {gpsLocation.longitude.toFixed(6)}</Text>
            </>
          ) : (
            <Text style={styles.dataText}>Retrieving location...</Text>
          )}
        </View>

        <View style={styles.dataCard}>
          <Text style={styles.cardTitle}>Device ID</Text>
          <Text style={styles.dataText}>{deviceId || 'Retrieving...'}</Text>
        </View>

        <View style={styles.dataCard}>
          <Text style={styles.cardTitle}>Battery Status</Text>
          {batteryStatus ? (
            <>
              <Text style={styles.dataText}>Level: {batteryStatus.level}</Text>
              <Text style={styles.dataText}>State: {batteryStatus.state}</Text>
            </>
          ) : (
            <Text style={styles.dataText}>Retrieving...</Text>
          )}
        </View>

        <View style={styles.dataCard}>
          <Text style={styles.cardTitle}>Received Data ({storedData.length})</Text>
          <Text style={styles.dataText}>Last received record:</Text>
          {storedData.length > 0 ? (
            <Text style={styles.dataText}>
              ID: {storedData[storedData.length - 1].deviceId.substring(0, 10)}...
              <br />
              Lat: {storedData[storedData.length - 1].latitude.toFixed(4)}
            </Text>
          ) : (
            <Text style={styles.dataText}>No data received yet.</Text>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
};


const App = () => {
  return (
    <RealmProvider>
      <AppContent />
    </RealmProvider>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0f2f5',
  },
  header: {
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#007bff',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  subtitle: {
    fontSize: 16,
    color: '#d4e3ff',
    marginTop: 5,
  },
  dataContainer: {
    flex: 1,
    padding: 10,
  },
  dataCard: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 15,
    marginVertical: 8,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 5,
    color: '#333',
  },
  dataText: {
    fontSize: 16,
    color: '#555',
  },
});

export default App;