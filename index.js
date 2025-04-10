const express = require('express');
const bodyparser = require('body-parser');
const cors = require('cors');
const mqtt = require('mqtt');
const http = require('http');
const app = express();
const mysql = require('mysql2/promise');
const socketIo = require('socket.io');
const server = http.createServer(app);
const io = socketIo(server);
const nodemailer = require('nodemailer');
const path = require('path');

const host = '192.168.108.204';
const port = '18883';
// const host = '192.168.108.234';
// const host = '10.101.10.35'
// const port = '1890';
const port_socket = '4040';
const port_API = '5050';
// const username = 'earth';
// const password = 'earth';
const username = 'hass';
const password = 'hass';
app.use(bodyparser.json());
app.use(cors());

const scheduleList = [];

const connectUrl = `mqtt://${host}:${port}`;
const client = mqtt.connect(connectUrl, {
    clean: true,
    connectTimeout: 4000,
    username: username,
    password: password,
    reconnectPeriod: 1000,
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'chomamuang1007@gmail.com',
        pass: 'qpvwfjmuhtkyfqix'
    }
});

let conn = null

const connectMySQL = async () => {
    const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
    try {
        conn = await mysql.createConnection({
            host: DB_HOST || 'db',
            port: DB_PORT || '3306',
            user: DB_USER || 'root',
            password: DB_PASSWORD || 'root',
            database: DB_NAME || 'MQTT'
        });
        console.log('MySQL connected');
    } catch (error) {
        console.error('Error connecting to MySQL:', error.message);
    }
};

/*Firebase*/
// // This registration token comes from the client FCM SDKs.
// const registrationTokenFromFlutter = 'YOUR_REGISTRATION_TOKEN';

// // นำเข้า Firebase Admin SDK เพื่อใช้งาน Firebase Cloud Messaging (FCM)
// const admin = require('firebase-admin');

// // นำเข้า serviceAccountKey JSON ที่ได้จาก Firebase Console
// const serviceAccount = require('./mqtt-fbec3-firebase-adminsdk-682is-ab49fe4323.json');

// // ตั้งค่าและ initialize Firebase Admin SDK ด้วย service account
// admin.initializeApp({
//     credential: admin.credential.cert(serviceAccount)
// });

// const message = {
//     data: {
//         score: '850',
//         time: '2:45'
//     },
//     token: registrationTokenFromFlutter // นำ token จาก Flutter มาใช้ที่นี่
// };

// admin.messaging().send(message)
//     .then((response) => {
//         console.log('Successfully sent message:', response);
//     })
//     .catch((error) => {
//         console.log('Error sending message:', error);
//     });
/*Firebase*/

async function status_from_device() {
    client.on('message', async (receivedTopic, message) => {
        try {
            const [gateway_ID, switch_ID, path] = receivedTopic.split('/');
            const parsedMessage = JSON.parse(message.toString()); // แปลงข้อความเป็น JSON

            if (!gateway_ID || !switch_ID || path) {
                console.log(`Invalid topic format: ${receivedTopic}`);
                return;
            }

            //แยก scene switch ด้วย brand

            const qeury_brand = 'SELECT brand FROM scene_switch WHERE scene_sw_ID = ?'
            const [ck_brand] = await conn.execute(qeury_brand, [switch_ID])

            const brand = ck_brand.length ? ck_brand[0].brand : null;

            if (brand) {

                if (brand === 'bticino') {

                    const [scene_sw] = await conn.execute(`SELECT key_state FROM scene_switch WHERE scene_sw_ID = ?`, [switch_ID]);

                    const key_state = scene_sw.length ? scene_sw[0].key_state : null;

                    const newState = parsedMessage[key_state];

                    console.log(`key_state FROM scene_bticino : ${key_state} -> ${newState}`)

                    await pub_to_device_from_sceneSW(gateway_ID, switch_ID, newState)
                    return;
                }
                else if (brand === 'schneider') {
                    console.log(`key_state FROM scene_schneider :${JSON.stringify(parsedMessage)}`);
                    let newState = '';
                    for (const key in parsedMessage) {
                        if (parsedMessage.hasOwnProperty(key) && key.endsWith('_event_notification')) {
                            newState = key;
                            console.log(`newState: ${newState}`);
                        }
                    }
                    await pub_to_device_from_sceneSW(gateway_ID, switch_ID, newState)
                    return;
                } else {
                    console.log(`Unknown brand: ${brand}`);
                    return;
                }

            }

            const query = 'SELECT * FROM mqtt_view WHERE gateway_ID = ? AND switch_ID = ?';
            const [result] = await conn.execute(query, [gateway_ID, switch_ID]);

            if (result.length === 0) {
                console.log(`Topic ${receivedTopic} does not exist in database.`);
                return;
            }

            const device = result[0]; // เราสนใจแค่ device เดียว
            const fields = ['state_1', 'state_2', 'state_3'];
            const results = [];

            for (const field of fields) {
                if (device[`key_${field}`] && parsedMessage.hasOwnProperty(device[`key_${field}`])) {
                    const newState = String(parsedMessage[device[`key_${field}`]]);

                    if (device[`value_${field}`] !== newState) {
                        console.log(`State changed for ${device[`key_${field}`]} from ${device[`value_${field}`]} to ${newState}`);

                        const updateStatusQuery = `UPDATE ${field} SET value_${field} = ? WHERE device_ID_FK = ?`;

                        await conn.execute(updateStatusQuery, [newState, device.device_ID]);

                        const deviceStatus = {
                            switch_ID: switch_ID,
                            [`${field}`]: device[`key_${field}`],
                            [`value_${field}`]: newState
                        };

                        results.push(deviceStatus);
                    }
                }
            }

            if (results.length > 0) {
                const getdata = JSON.stringify(results);
                io.emit('mqtt-message', { getdata });
                console.log(`Data sent: ${getdata}`);
            }

        } catch (error) {
            console.error('Database query error:', error.message);
        }
    });
}

async function get_device_data(req, res) {
    try {
        const { Home_No, password } = req.body;
        console.log(`Home_No: ${Home_No} password:${password}`);
        const [CK_password] = await conn.execute(`SELECT password FROM Home WHERE Home_No = ? AND password = ?`, [Home_No, password]);

        const complete = CK_password.length ? CK_password[0] : null;

        if (!complete) {
            res.status(400).json({ error: 'The Home No OR password is incorrect' });
            return;
        } else {
            const [results] = await conn.execute(`SELECT * FROM get_device_data_view WHERE Home_No = ? AND Device_Type != 'scene'`, [Home_No]);
            //console.log(`Results: ${JSON.stringify(results)}`);
            res.json({ RoomData: results });
        }
    } catch (error) {
        console.error('Error fetching data:', error.message);
        res.status(500).json({ error: 'Error fetching data' });
    }
}

async function publish_to_device(req, res) {
    try {
        const { Home_No, switch_ID, state_ID, state } = req.body;

        console.log(`${req.body}`)
        const [rows] = await conn.execute(`SELECT gateway_ID FROM Home WHERE Home_No = ?`, [Home_No]);

        const gateway_ID = rows.length ? rows[0].gateway_ID : null;

        if (!gateway_ID) {
            res.status(404).json({ error: 'Gateway ID not found' });
            return;
        }

        const topic = `${gateway_ID}/${switch_ID}/set`;

        // let message = `"${state_ID}":"${state}"`;
        let message
        if (typeof state === 'number') {
            message = `{"${state_ID}":${state}}`;

        } else {
            message = `{"${state_ID}":"${state}"}`;
        }

        // if (state_ID_2 && state_2) {message += `,"${state_ID_2}":"${state_2}"`;}

        console.log(`Message: ${message}`);
        client.publish(topic, message, (err) => {
            if (err) {
                console.error('Error pub msg:', err);
                res.status(500).json({ error: 'Error pub msg' });
            } else {
                console.log(`Pub msg to ${topic}: ${message}`);
                res.json({ SET: message });
            }
        });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: 'Error' });
    }
}

async function sub_to_device(topic, data) {
    return new Promise((resolve, reject) => {
        const jsonString = JSON.stringify(data);
        console.log('Pub msg:', data);

        client.publish(`${topic}/get`, jsonString, (err) => {
            if (err) {
                console.error('Error pub msg:', err);
                return reject(new Error('Error pub msg'));
            }
        });

        const timeout = setTimeout(() => {
            reject(new Error('Response timeout'));
        }, 5000); // Wait for 5 seconds

        const messageHandler = (receivedTopic, message) => {

            if (receivedTopic === topic) {
                clearTimeout(timeout);
                client.removeListener('message', messageHandler); // Remove listener once message is received
                const parsedMessage = JSON.parse(message.toString()); // May be Buffer -> String -> JSON Object
                //console.log(`Received msg from ${receivedTopic}`);
                resolve(parsedMessage); // Complete
            }
        };

        client.on('message', messageHandler); // Wait for message on specific topic
        //console.log(`messageHandler : ${messageHandler}`)
    });
}

async function get_device_status(topic, fields) {
    try {
        const requestData = { "state": "" };
        const response = await sub_to_device(topic, requestData);
        const responseData = fields.reduce((acc, field) => {
            acc[field] = response[field];
            return acc;
        }, {});

        console.log(`get_device_status : ${JSON.stringify(responseData)}`);
        return responseData;
    } catch (error) {
        console.error('Error get_device_status:', error.message);
        throw new Error(error.message);
    }
}

async function check_topic(req, res) {
    try {
        const { Home_No, Sub_home_ID } = req.body;
        const [check_gw_ID] = await conn.execute(`SELECT gateway_ID FROM Home WHERE Home_No = ?`, [Home_No]);

        const gateway_ID = check_gw_ID.length ? check_gw_ID[0].gateway_ID : null;

        if (!gateway_ID) {
            return res.status(404).json({ error: 'Gateway ID not found' });
        }

        const [check_state] = await conn.execute(`SELECT switch_ID, key_state_1, key_state_2, key_state_3 FROM get_device_data_view WHERE Home_No = ? AND Sub_home_ID = ?;`, [Home_No, Sub_home_ID]);


        if (!check_state.length) {
            return res.status(404).json({ error: 'State not found' });
        }

        const results = [];

        for (const device of check_state) {
            const topic = `${gateway_ID}/${device.switch_ID}`;
            const fields = [device.state_1];

            if (device.state_2) fields.push(device.state_2);
            if (device.state_3) fields.push(device.state_3);

            try {
                const deviceStatus = await get_device_status(topic, fields);

                if (!device.state_2) {
                    results.push({ switch_ID: device.switch_ID, state_1: device.state_1, value_state_1: deviceStatus[`${device.state_1}`] });
                }
                else if (!device.state_3) {
                    results.push({ switch_ID: device.switch_ID, state_1: device.state_1, state_2: device.state_2, value_state_1: deviceStatus[`${device.state_1}`], value_state_2: deviceStatus[`${device.state_2}`] });
                } else {
                    results.push({ switch_ID: device.switch_ID, state_1: device.state_1, state_2: device.state_2, state_3: device.state_3, value_state_1: deviceStatus[`${device.state_1}`], value_state_2: deviceStatus[`${device.state_2}`], value_state_3: deviceStatus[`${device.state_3}`] });
                }

            } catch (error) {
                console.error(`Error getting status for device ${device.switch_ID}:`, error.message);
            }
        }
        console.log(`Results: ${JSON.stringify(results)}`);
        res.status(200).json({ results });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

async function register(req, res) {
    try {
        const { Home_No, People_ID, Receipt_number, email, password } = req.body;
        console.log('Request body:', req.body); // ตรวจสอบค่าของ req.body

        // Query ข้อมูลจากฐานข้อมูล
        const [results] = await conn.execute(
            `SELECT * FROM register WHERE Home_No = ? AND People_ID = ? AND Receipt_number = ?`,
            [Home_No, People_ID, Receipt_number]
        );
        console.log('Query results:', JSON.stringify(results)); // ตรวจสอบค่าของผลลัพธ์ที่ query ออกมา

        const complete = results.length ? results[0] : null;

        // ถ้า complete เป็น null หมายความว่าไม่พบข้อมูลที่ตรงกัน
        if (!complete) {
            res.status(400).json({ error: 'Status or Data does not match' });
            return;
        }

        // ตรวจสอบค่า Home_No, People_ID และ Receipt_number
        if (complete.Home_No !== Home_No) {
            res.status(400).json({ error: 'Home number does not match' });
            return;
        }
        if (complete.People_ID !== People_ID) {
            res.status(400).json({ error: 'Personal Identity does not match' });
            return;
        }
        if (complete.Receipt_number !== Receipt_number) {
            res.status(400).json({ error: 'Receipt number does not match' });
            return;
        }

        // อัพเดต password ในฐานข้อมูล
        await conn.execute(
            `UPDATE Home SET password = ? WHERE Home_No = ?`,
            [password, Home_No]
        );

        // ตั้งค่าการส่งอีเมล
        const mailOptions = {
            from: 'chomamuang1007@gmail.com',
            to: email,
            subject: 'Registration Successful',
            text: `
                Dear ${complete.firstname} ${complete.lastname},
            
                We are pleased to inform you that your password update was successful.
                Thank you for using our service.
            
                Your registration details:
                - Room : ${complete.Home_No}
                - Receipt : ${complete.Receipt_number}
            
                If you have any questions or further inquiries, please feel free to contact us via this email.
            
                Thank you,
                The Smart Home Team
            `
        };

        // ส่งอีเมล
        transporter.sendMail(mailOptions, function (error, info) {
            if (error) {
                console.log(error);
            } else {
                console.log('Email sent: ' + info.response);
            }
        });

        console.log('Password updated successfully');
        res.status(200).json({ status: 'Successfully registered' });

    } catch (error) {
        console.error('Error register:', error.message);
        res.status(500).json({ error: error.message });
    }
}

async function customize_name(req, res) {
    try {
        const { cus_name, Sub_home_ID } = req.body;
        await conn.execute(`UPDATE Sub_home SET customize_name = ? WHERE Sub_home_ID = ?`, [cus_name, Sub_home_ID]);
        console.log('Customize name updated successfully')
        res.status(200).json({ message: 'Customize name updated successfully' });
    } catch (error) {
        console.error('Error customize_name:', error.message);
        res.status(500).json({ error: error.message });
    }
}

async function get_profile(req, res) {
    try {
        const { Home_No } = req.body;
        const [results] = await conn.execute(`SELECT * FROM profile_view WHERE Home_No = ?;`, [Home_No])
        if (!results) {
            res.status(400).json({ error: 'not found profile' });
            return;
        } else {

            console.log(`Results: ${JSON.stringify(results)}`);
            res.json({ RoomData: results });
        }
    }
    catch (error) {
        console.log('Error get_profile', error.message);
        res.json(500).json({ error: error.message });
    }
}

/*scene switch */
async function pub_to_device_from_sceneSW(gateway_ID, scene_ID, newStatenum) {
    try {
        //เอา switch มา check ว่าอยู่ group ไหน EX group 1,2,3,4 
        const [check_group] = await conn.execute(`SELECT action_group_1, action_group_2, action_group_3, action_group_4 FROM scene_sw_view WHERE scene_sw_ID = ?;`, [scene_ID]);

        const newState = newStatenum.toString();
        if (check_group.length === 0) {
            console.log(`not found Topic -> ${gateway_ID}/${scene_ID} \n message -> ${newState}`);
            return;
        }

        //console.log(`test publish scene switch : ${JSON.stringify(check_group)}`);

        let foundG = null;
        const data = check_group[0];

        switch (newState) {
            case data.action_group_1:
                foundG = "1";
                break;
            case data.action_group_2:
                foundG = "2";
                break;
            case data.action_group_3:
                foundG = "3";
                break;
            case data.action_group_4:
                foundG = "4";
                break;
            default:
                console.log("Value not found");
        }

        if (foundG) {
            //console.log(`Found value "${newState}" at key "${foundG}"`);
        }

        // ดึง scene_sw_g_ID จากฐานข้อมูล
        const [scene_sw_g_ID] = await conn.execute(
            `SELECT scene_sw_g${foundG}_ID FROM scene_sw_view WHERE scene_sw_ID = ?`,
            [scene_ID]
        );
        console.log(`scene_sw_g_ID result: ${JSON.stringify(scene_sw_g_ID)}`);

        // ตรวจสอบ scene_sw_g_ID
        const composite_ID = scene_sw_g_ID.length ? scene_sw_g_ID[0][`scene_sw_g${foundG}_ID`] : null;
        if (!composite_ID) {
            console.error('scene_sw_g_ID not found');
            return;
        }
        console.log(`Composite ID: ${composite_ID}`);

        const [result] = await conn.execute(`SELECT * FROM g${foundG}_scene_control WHERE scene_sw_g${foundG}_ID = ?;`, [composite_ID])

        console.log(`test_pubTodevice result : ${JSON.stringify(result)}`)
        // const device = result[0];
        const fields = result;
        //console.log(`test_pubTodevice field : ${JSON.stringify(fields)}`)
        for (const field of fields) {
            console.log(`test_pubTodevice field : ${JSON.stringify(field)}`)
            if (field[`switch_ID`]) {

                const topic = `${gateway_ID}/${field[`switch_ID`]}/set`;
                const state = `{"${field[`key_state`]}":"${field[`value_state`]}"}`;
                //const message = JSON.stringify(state); // แปลง state เป็น string

                //console.log(`Message: ${message}`);
                client.publish(topic, state, (err) => {
                    if (err) {
                        console.error('Error publishing message:', err);
                    } else {
                        console.log(`Published message to ${topic}: ${state}`);
                    }
                });
            }
        }


    } catch (error) {
        console.log('error pub_to_device_from_sceneSW :', error.message);
    }
}

async function get_sceneSW(req, res) {
    try {
        const { Home_No } = req.body;
        const [switch_ID] = await conn.execute(`SELECT scene_sw_ID FROM home_scene_sw_view WHERE Home_No = ?;`, [Home_No]);

        if (switch_ID.length === 0) {
            return res.status(404).json({ error: 'No scene_sw device at Home_No' });
        }

        const results = [];

        for (const device of switch_ID) {

            const [rows] = await conn.execute(`SELECT brand, action_group_1, action_group_2, action_group_3, action_group_4,switch_type FROM scene_sw_view WHERE scene_sw_ID = ?;`, [device.scene_sw_ID]);

            if (rows.length === 0) {
                console.log(`No action_group at switch_ID : ${device.scene_sw_ID}`);
                continue;
            }

            const row = rows[0];

            // กรองข้อมูลที่ไม่ใช่ null
            const data = {
                switch_ID: device.scene_sw_ID,
                brand: row.brand,
                switch_type: row.switch_type,
                group_1: row.action_group_1 || undefined,
                group_2: row.action_group_2 || undefined,
                group_3: row.action_group_3 || undefined,
                group_4: row.action_group_4 || undefined
            };
            if (Object.values(data).some(value => value !== undefined)) {
                results.push(data);
            }
        }

        res.status(200).json({ results: results });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
}

async function set_sceneSW(req, res) {
    try {
        console.log(`SetsceneSW : ${JSON.stringify(req.body)}`);

        // ค้นหา object ที่มี scene_switch_ID
        const sceneData = req.body.find(item => item.scene_switch_ID);
        const devicesData = req.body.filter(item => item.switch_ID); // กรองเฉพาะอุปกรณ์

        // ตรวจสอบว่าเจอ sceneData หรือไม่
        if (!sceneData) {
            console.log('Missing scene switch data');
            return res.status(400).json({ error: 'Missing scene switch data' });
        }

        const { group, action_group, scene_switch_ID } = sceneData;

        // ตรวจสอบ parameter
        if (!group || !action_group || !scene_switch_ID) {
            console.log('Missing required fields');
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // ดึง scene_sw_g_ID จากฐานข้อมูล
        const [scene_sw_g_ID] = await conn.execute(
            `SELECT scene_sw_g${group}_ID FROM scene_sw_view WHERE scene_sw_ID = ?`,
            [scene_switch_ID]
        );
        console.log(`scene_sw_g_ID result: ${JSON.stringify(scene_sw_g_ID)}`);

        // ตรวจสอบ scene_sw_g_ID
        const composite_ID = scene_sw_g_ID.length ? scene_sw_g_ID[0][`scene_sw_g${group}_ID`] : null;
        if (!composite_ID) {
            return res.status(404).json({ error: 'scene_sw_g_ID not found' });
        }
        console.log(`Composite ID: ${composite_ID}`);

        //ถ้าไม่มีข้อมูลมาให้ reset ลบทั้งหมด
        if (devicesData.length === 0) {
            console.log(`Deleting from g${group}_scene_control for composite ID: ${composite_ID}`);
            await conn.execute(`DELETE FROM g${group}_scene_control WHERE scene_sw_g${group}_ID = ?`, [composite_ID]);

            return res.status(200).json({ message: `delete scenesw at : ${group} && ${action_group} && ${scene_switch_ID}` });
        }

        const [ck_up_or_in] = await conn.execute(
            `SELECT * FROM g${group}_scene_control WHERE scene_sw_g${group}_ID = ?;`,
            [composite_ID]
        );
        const up_or_in = ck_up_or_in.length ? ck_up_or_in[0] : null;

        if (!up_or_in) {
            console.log(`Inserting new records for group ${group}`);
            for (let i = 0; i < devicesData.length; i++) {
                const { switch_ID, key_state, value_state } = devicesData[i];
                await insert_or_update_device(group, composite_ID, switch_ID, key_state, value_state);
            }
        } else {
            console.log(`Deleting from g${group}_scene_control for composite ID: ${composite_ID}`);
            await conn.execute(`DELETE FROM g${group}_scene_control WHERE scene_sw_g${group}_ID = ?`, [composite_ID]);
            console.log(`Updating records for group ${group}`);
            for (let i = 0; i < devicesData.length; i++) {
                const { switch_ID, key_state, value_state } = devicesData[i];
                await insert_or_update_device(group, composite_ID, switch_ID, key_state, value_state, true);
            }
        }

        res.status(200).json({ message: "SetsceneSW successfully" });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
}

async function insert_or_update_device(group, composite_ID, switch_ID, key_state, value_state, isUpdate = false) {
    const table = `g${group}_scene_control`;

    try {

        if (!switch_ID || !key_state || !value_state) {
            return; // Exit if no switch_ID, key_state, or value_state
        }

        if (isUpdate) {
            //มีข้อมูลอยู่แล้วให้ delete และ insret เข้าไปใหม่
            console.log(`No existing record to update in ${table}, inserting new record.`);
            await conn.execute(
                `INSERT INTO ${table} (switch_ID, key_state, value_state, scene_sw_g${group}_ID) VALUES (?, ?, ?, ?)`,
                [switch_ID, key_state, value_state, composite_ID]);
        } else {
            console.log(`Inserting new record into ${table} for composite ID: ${composite_ID}`);
            await conn.execute(
                `INSERT INTO ${table} (switch_ID, key_state, value_state, scene_sw_g${group}_ID) VALUES (?, ?, ?, ?)`,
                [switch_ID, key_state, value_state, composite_ID]
            );
        }
    } catch (error) {
        console.error(`Error in insert_or_update_device for ${table}:`, error.message);
        throw error; // Rethrow the error to be caught in the calling function
    }
}

async function pub_to_device_from_scene_sw_flutter(req, res) {
    try {
        const { switch_ID, group } = req.body

        const [check_gw_ID] = await conn.execute(`SELECT gateway_ID FROM home_scene_sw_view WHERE scene_sw_ID = ?;`, [switch_ID])

        const gateway_ID = check_gw_ID.length ? check_gw_ID[0].gateway_ID : null;

        if (!gateway_ID) {
            return res.status(404).json({ error: 'Gateway ID not found' });
        }

        const [scene_sw_g_ID] = await conn.execute(
            `SELECT scene_sw_g${group}_ID FROM scene_sw_view WHERE scene_sw_ID = ?`,
            [switch_ID]
        );
        console.log(`scene_sw_g_ID result: ${JSON.stringify(scene_sw_g_ID)}`);

        // ตรวจสอบ scene_sw_g_ID
        const composite_ID = scene_sw_g_ID.length ? scene_sw_g_ID[0][`scene_sw_g${group}_ID`] : null;
        if (!composite_ID) {
            return res.status(404).json({ error: 'scene_sw_g_ID not found' });
        }
        console.log(`Composite ID: ${composite_ID}`);

        const [result] = await conn.execute(`SELECT 
            switch_ID, key_state, value_state
            FROM g${group}_scene_control WHERE scene_sw_g${group}_ID = ?;`, [composite_ID])

        if (!result.length) {
            return res.status(404).json({ error: 'No device found for the provided composite_ID' });
        }

        const fields = result;

        for (const field of fields) {
            console.log(`test_pubTodevice field : ${JSON.stringify(field)}`)

            if (field[`switch_ID`]) {

                const topic = `${gateway_ID}/${field[`switch_ID`]}/set`;
                const state = `{"${field[`key_state`]}":"${field[`value_state`]}"}`;
                //const message = JSON.stringify(state); // แปลง state เป็น string

                //console.log(`Message: ${message}`);
                client.publish(topic, state, (err) => {
                    if (err) {
                        console.error('Error publishing message:', err);
                    } else {
                        console.log(`Published message to ${topic}: ${state}`);
                    }
                });
            }
        }

        res.status(200).json({ message: 'Messages published successfully' });

    } catch (error) {
        console.log('error pub_to_device_from_sceneSW flutter:', error.message);
        res.status(500).json({ error: error.message });
    }
}

async function get_scene_sw_group(req, res) {
    try {
        const { scene_switch_ID, group, action_group } = req.body
        // console.log(`get_scene_sw_group : ${JSON.stringify(req.body)}`)

        if (!scene_switch_ID || !group || !action_group) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const [scene_sw_g_ID] = await conn.execute(
            `SELECT scene_sw_g${group}_ID FROM scene_sw_view WHERE scene_sw_ID = ?`,
            [scene_switch_ID]
        );
        console.log(`scene_sw_g_ID result: ${JSON.stringify(scene_sw_g_ID)}`);

        // ตรวจสอบ scene_sw_g_ID
        const composite_ID = scene_sw_g_ID.length ? scene_sw_g_ID[0][`scene_sw_g${group}_ID`] : null;
        if (!composite_ID) {
            return res.status(404).json({ error: 'scene_sw_g_ID not found' });
        }
        console.log(`Composite ID: ${composite_ID}`);

        const [results] = await conn.execute(`SELECT 
            switch_ID, key_state, value_state
            FROM g${group}_scene_control WHERE scene_sw_g${group}_ID = ?;`, [composite_ID])//แก้ไขให้ส่งidไปด้วย ิิ

        console.log(`get_scene_sw_group : ${JSON.stringify(results)}`)
        res.status(200).json({ results: results });
    }
    catch (error) {
        console.log('error get_scene_sw_group:', error.message);
        res.status(500).json({ error: error.message });
    }
}

/* scene switch */

/* SETTIME */
async function set_schedule(req, res) {
    try {
        const { switch_ID, state, set_time, device_ID, active } = req.body
        //console.log(`set_schedule ${JSON.stringify(req.body)}`)
        console.log(`set schedule : device_ID : ${device_ID} ${switch_ID} -> ${set_time}`)

        // เก็บข้อมูลในฐานข้อมูลโดยใช้เวลาอย่างเดียว
        await conn.execute(`INSERT INTO set_time (state, set_time, device_ID_FK, active) VALUES (?, ?, ?,?);`, [state, set_time, device_ID, active]);
        await query_schedule();
        const newSchedule = await update_settime(switch_ID, set_time, device_ID, state);

        if (!newSchedule) {
            res.status(404).json({ error: 'newSchedule not found' });
            return;
        }

        res.status(200).json({ results: newSchedule });

    } catch (error) {
        console.error('Error in update_settime:', error.message);
        res.status(500).json({ error: error.message });
    }
}

async function query_schedule() {
    try {
        // ล้างข้อมูลใน array scheduleList
        scheduleList.length = 0;

        const [rows] = await conn.execute(`SELECT id, switch_ID, state, set_time, device_ID, active FROM set_time_view WHERE 1;`);

        console.log('query_schedule rows:', rows);

        scheduleList.push(...rows);

        console.log('Schedules loaded:', scheduleList);

    } catch (error) {
        // แสดงผล error หากมีข้อผิดพลาดเกิดขึ้นตอน query
        console.log('Database query error:', error.message);
    }
}

async function update_settime(switch_ID, set_time, device_ID, state) {
    try {

        const [row] = await conn.execute(`SELECT * FROM set_time_view WHERE switch_ID = ? AND set_time = ?  AND device_ID = ?;`, [switch_ID, set_time, device_ID]);

        if (!row.length) {
            console.log('error data set_time');
            return null;
        }
        // สร้างออบเจ็กต์ใหม่จากข้อมูลที่ได้จากฐานข้อมูล
        const newSchedule = {
            set_time_ID: row[0].id,
            switch_ID: row[0].switch_ID,
            set_time: row[0].set_time,
            active: row[0].active,
            key_state_1: row[0].key_state_1,
            status_1: state[row[0].key_state_1],
        };

        if (row[0].key_state_2) {
            newSchedule['key_state_2'] = row[0].key_state_2;
            newSchedule['status_2'] = state[row[0].key_state_2];
        }
        if (row[0].key_state_3) {
            newSchedule['key_state_3'] = row[0].key_state_3;
            newSchedule['status_3'] = state[row[0].key_state_3];
        }

        if (Object.keys(newSchedule).length > 0) {
            console.log(`Data sent -> ${JSON.stringify(newSchedule)}`);
            return newSchedule;
        }

    } catch (error) {
        console.log('error send set_time to flutter:', error.message);
    }
}

async function set_time_publish(switch_ID, state) {

    const [rows] = await conn.execute(`SELECT gateway_ID FROM mqtt_view WHERE switch_ID = ?;`, [switch_ID]);

    const gateway_ID = rows.length ? rows[0].gateway_ID : null;

    if (!gateway_ID) {
        console.log(`gateway_ID not found`);
        return;
    }

    const topic = `${gateway_ID}/${switch_ID}/set`;

    const message = JSON.stringify(state); // แปลง state เป็น string

    console.log(`Message: ${message}`);
    client.publish(topic, message, (err) => {
        if (err) {
            console.error('Error publishing message:', err);
            return;
        } else {
            console.log(`Published message to ${topic}: ${message}`);
            return;
        }
    });
}

async function check_and_control_devices() {
    try {
        const currentTime = new Date();
        const currentHour = (currentTime.getHours() + 7) % 24; // Adjust to Thailand Time Zone (UTC+7)
        const currentMinute = currentTime.getMinutes();

        let matchedCount = 0;

        for (const schedule of scheduleList) {
            const [scheduleHour, scheduleMinute] = schedule.set_time.split(':').map(Number); // Extract hour and minute from set_time
            const active = schedule.active; // Access active directly as it's a number (0 or 1)

            // Check if current time matches the scheduled time and the schedule is active
            if (currentHour === scheduleHour && currentMinute === scheduleMinute && active === 1) { // Compare active directly as number
                // Publish the state to the device
                await set_time_publish(schedule.switch_ID, schedule.state);

                console.log(`Control device ID: ${schedule.device_ID} with state: ${JSON.stringify(schedule.state)} at time: ${currentTime.toTimeString()}`);
                matchedCount++;
            }
        }

        // Log if no schedules were matched at the current time
        if (matchedCount === 0) {
            console.log('No matching schedules found at this time:', currentTime.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' }));

        }
    } catch (error) {
        console.error('Error in check_and_control_devices:', error); // Print full error stack
    }
}

// Schedule the check to run every minute
setInterval(check_and_control_devices, 60000);

// run every 1 min (60000 ms)

async function delete_schedule(req, res) {
    try {
        const { set_time_ID } = req.body
        await conn.execute(`DELETE FROM set_time WHERE set_time.id = ?`, [set_time_ID])
        await query_schedule()

        res.status(200).json({ message: 'delete set_time successfully' })
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

async function active_schedule(req, res) {
    try {
        const { set_time_ID, active } = req.body
        await conn.execute(`UPDATE set_time SET active = ? WHERE set_time.id = ?`, [active, set_time_ID])
        await query_schedule()

        res.status(200).json({ message: 'update active set_time successfully' })
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

async function get_schedule(req, res) {
    try {
        const { switch_ID, key_state_1 } = req.body //switch_ID + key_state_1 = unique
        console.log(`get schedule : ${switch_ID} -> ${key_state_1}`)
        const [rows] = await conn.execute(`SELECT * FROM set_time_view where switch_ID = ? AND key_state_1 = ?;`, [switch_ID, key_state_1]);
        if (!rows.length) {
            console.log(`getschedule: error data set_time at -> switch : ${switch_ID} -> key_state_1 : ${key_state_1}`);
            return;
        }

        const results = [];

        for (const row of rows) {
            try {
                const state = row['state'];  //เนื่องจากเก็บข้อมูลเป็น JSON แล้วต้องการจะดึงค่า value ของ key_state_1 ||key_state_2 ||key_state_3 e.g.-> ON
                console.log('state : ', state);

                const newSchedule = {
                    set_time_ID: row.id,
                    switch_ID: row.switch_ID,
                    set_time: row.set_time,
                    active: row.active,
                    key_state_1: row.key_state_1,
                    status_1: state[row.key_state_1],
                };

                if (row.key_state_2) {
                    newSchedule['key_state_2'] = row.key_state_2;
                    newSchedule['status_2'] = state[row.key_state_2];
                }
                if (row.key_state_3) {
                    newSchedule['key_state_3'] = row.key_state_3;
                    newSchedule['status_3'] = state[row.key_state_3];
                }

                results.push(newSchedule);
            } catch (error) {
                console.error(`Error getting status for device ${row.switch_ID}:`, error.message);
            }
        }

        console.log(`Data sent ->${JSON.stringify(results)}`);
        res.status(200).json({ message: results })
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

/* SETTIME */

client.on('offline', () => {
    console.log('Client is offline');
})

client.on('connect', async () => {
    console.log('Connected to OBT_MQTT');
    client.subscribe('#', (err, granted) => {
        if (err) {
            console.log(err);
        }
        console.log(granted);
        console.log("Subscribed to all topics");
    });
    await status_from_device()
});

io.on('connection', (socket) => {
    console.log('A user connected');
    socket.on('disconnect', () => {
        console.log('User disconnected');
    });

    // ตรวจสอบเหตุการณ์เชื่อมต่อผิดพลาด
    socket.on('connect_error', (err) => {
        console.log('Connection Error:', err.message);
    });

    socket.on('connect_timeout', () => {
        console.log('Connection Timeout');
    });
});

/*scene switch*/

app.post('/get-scene-sw-group', async (req, res) => {
    await get_scene_sw_group(req, res)
})

app.post('/publish-scene-sw', async (req, res) => {
    await pub_to_device_from_scene_sw_flutter(req, res);
});

app.post('/set-scene-sw', async (req, res) => {
    await set_sceneSW(req, res);
});

app.post('/get-scene-sw', async (req, res) => {
    await get_sceneSW(req, res);
});
/*scene switch*/

/* device schedule */
app.post('/sets-a-schedule', async (req, res) => {
    await set_schedule(req, res);
});

app.post('/delete-a-schedule', async (req, res) => {
    await delete_schedule(req, res);
});

app.post('/active-a-schedule', async (req, res) => {
    await active_schedule(req, res);
});

app.post('/get-a-schedule', async (req, res) => {
    await get_schedule(req, res);
});
/* device schedule */

app.post('/login', async (req, res) => {
    await get_device_data(req, res);
});

app.post(`/publish-to-device`, async (req, res) => {
    await publish_to_device(req, res);
});

app.post('/get-device-status', async (req, res) => {
    //await check_topic(req, res);
});

app.post('/register', async (req, res) => {
    await register(req, res);
});

app.post('/customize-name', async (req, res) => {
    await customize_name(req, res);
});

app.post('/get-profile', async (req, res) => {
    await get_profile(req, res);
});

/*improve*/
/*improve*/
app.use('/images', express.static(path.join(__dirname, 'uploads')));

app.listen(port_API, async () => {
    setTimeout(async () => {
        await connectMySQL();
        //await query_schedule();
        console.log(`Server running at http://localhost:${port_API}/`);
    }, 15000); // หน่วงเวลา 15 วินาที
});

server.listen(port_socket, () => {
    console.log(`Socket.io server running at http://localhost:${port_socket}/`);
});

//``
