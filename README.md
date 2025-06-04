#  Smart Home Backend

A backend system for a smart home application developed during a cooperative education program at Obotrons Corporation Co., Ltd.
This system communicates with Zigbee-enabled devices via MQTT and Zigbee2MQTT, supporting real-time control, scheduling, and scene switching.

##  Project Summary

This project enables centralized control of multiple smart devices (e.g. lights, plugs, curtains, dimmable lights) using Node.js, MQTT, and Zigbee2MQTT.
It provides RESTful APIs for a Flutter-based mobile app to control and monitor device status in real time, with database integration replacing JSON for better data management.

##  Key Features

*  **Real-time Device Control**: Toggle power and brightness, and receive instant status updates via MQTT.
*  **Scheduled Automation**: Set up scheduled tasks for energy efficiency (e.g. turn off light at 9:00 PM).
*  **Scene Switch**: Group multiple devices and control them simultaneously from one switch.
