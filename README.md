# doorbell-ai-ha

## Overview

This project aims to convert a traditional intercom into a smart device using machine learning. The system detects the intercom chime and sends a notification via Telegram. This README provides an overview of the project's journey, implementation details, and usage instructions.

## Project Journey

The project evolved through several attempts:

1.  **Audio Fingerprinting:** Initial approach using audio fingerprinting (similar to Shazam). However, the chime was too short for effective fingerprinting.
2.  **ESP32 Integration:** Tried using an ESP32 connected to the intercom, but encountered power issues and significant feedback when connecting it to the intercom.
3.  **Tone Detection:** Attempted tone detection, but the library failed to pick up the intercom tones, though it detected beeps from other appliances like washing machines and dishwashers.
4.  **Machine Learning:** Successfully implemented machine learning to detect the intercom chime. Despite having no prior experience with machine learning, I managed to create, train, and deploy a model within 24 hours using Edge Impulse.

## Implementation

### Tools and Technologies

- **Edge Impulse:** Used to create and train the machine learning model.
- **TypeScript:** Programming language used for coding the solution.
- **Docker:** For containerizing the application.
- **Telegram API:** To send notifications upon detecting the intercom chime.

### Steps

1.  **Data Collection:** Recorded multiple samples of the intercom chime using a microphone connected to the host server.
2.  **Model Training:** Used Edge Impulse to train a machine learning model with the collected data.
3.  **Integration:** Developed a TypeScript application to interface with the trained model.
4.  **Deployment:** Containerized the application using Docker.
5.  **Notification:** Integrated the Telegram API to send notifications when the intercom chime is detected.

## Usage

### Prerequisites

- **Intel Server:** Ensure you have a machine to run docker near your intercom.
- **Microphone:** Connect a microphone to the ESP32 to capture the intercom chime.
- **Edge Impulse Account:** Sign up for an account at [Edge Impulse](https://edgeimpulse.com/).
- **Docker:** Install Docker on your machine.
- **Telegram Bot:** Create a Telegram bot and obtain the API token.

### Setup

env

```env
HOMEASSISTANT_URL=
HOMEASSISTANT_INTERCOM_RING_WEBHOOK_ID=
MIC_HW_ID=
```

WIP.

### Notification

When the intercom chime is detected, a notification will be sent to your specified Telegram chat.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

This project is licensed under the MIT License.

---

Feel free to reach out if you have any questions or need further assistance.

Happy coding! 🚀
