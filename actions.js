/**
 * Unless explicitly stated otherwise all files in this repository are licensed
 * under the MIT License.
 *
 * This product includes software developed at Datadog
 * (https://www.datadoghq.com/).
 *
 * Copyright 2018 Datadog, Inc.
 */

const ts_day = 60*60*24;

module.exports = (shared, logger, Channel, slack, slackInteractions) => {
    slackInteractions.action("menu_button", async (payload) => {
        logger.info("Button press", {
            user_id: payload.user.id,
            type: "button",
            callback_id: "menu_button",
            action: payload.actions[0]
        });

        if ("request_private_channel" == payload.actions[0].name) {
            const reply = payload.original_message;
            delete reply.attachments;
            reply.text = ":building_construction: Requesting private channel...";
            shared.requestChannelDialog(payload.trigger_id, {});
            return reply;
        } else if ("list_private_channels" == payload.actions[0].name) {
            const { offset, searchTerms } = JSON.parse(payload.actions[0].value);
            return shared.listChannels(offset || 0, searchTerms || "");
        }
    });

    slackInteractions.action("unarchive_channel_button", async (payload) => {
        logger.info("Button press", {
            user_id: payload.user.id,
            type: "button",
            callback_id: "unarchive_channel_button",
            action: payload.actions[0]
        });

        const channel = payload.actions[0].value;
        const reply = payload.original_message;

        if ("restore_channel" == payload.actions[0].name) {
            try {
                await slack.user.conversations.unarchive({ channel });
            } catch (err) {
                if (err.data) {
                    logger.error(err.data);
                    return { text: "Fatal: unknown platform error " + err.data };
                } else {
                    logger.error(err);
                    return { text: "Fatal: unknown platform error" };
                }
            }

            for (let i = 0; i < reply.attachments.length; ++i) {
                if (reply.attachments[i].actions &&
                    channel == reply.attachments[i].actions[0].value) {
                    delete reply.attachments[i].actions;
                    reply.attachments[i].color = "good";
                    reply.attachments[i].text += "\n:recycle: This channel is now restored.";
                    return reply;
                }
            }
        }
    });

    slackInteractions.action("join_channel_button", async (payload) => {
        logger.info("Button press", {
            user_id: payload.user.id,
            type: "button",
            callback_id: "join_channel_button",
            action: payload.actions[0]
        });

        const channel = payload.actions[0].value;
        const reply = payload.original_message;

        if ("join_channel" == payload.actions[0].name) {
            try {
                await slack.user.conversations.invite({ channel, users: payload.user.id });
            } catch (err) {
                if (err.data) {
                    if ("channel_not_found" == err.data.error || "is_archived" == err.data.error) {
                        return { text: "Oops, looks like this channel is already inactive. " +
                            "Please refresh the channel list." };
                    }
                } else {
                    logger.error(err);
                    return { text: "Fatal: unknown platform error" };
                }
            }

            // find the attachement associated with that button and update it to
            // reflect the change
            for (let i = 0; i < reply.attachments.length; ++i) {
                if (reply.attachments[i].actions &&
                    channel == reply.attachments[i].actions[0].value) {
                    reply.attachments[i].actions.splice(0, 1);
                    reply.attachments[i].color = "good";
                    reply.attachments[i].text += "\n:white_check_mark: You have been invited to this channel.";
                    return reply;
                }
            }
        } else if ("archive_channel" == payload.actions[0].name) {
            try {
                await slack.user.conversations.archive({ channel });
            } catch (err) {
                if (err.data) {
                    if ("channel_not_found" == err.data.error || "already_archived" == err.data.error) {
                        return { text: "Oops, looks like this channel is already inactive. " +
                            "Please refresh the channel list." };
                    }
                } else {
                    logger.error(err);
                    return { text: "Fatal: unknown platform error" };
                }
            }

            for (let i = 0; i < reply.attachments.length; ++i) {
                if (reply.attachments[i].actions &&
                    channel == reply.attachments[i].actions[0].value) {
                    delete reply.attachments[i].actions;
                    reply.attachments[i].color = "warning";
                    reply.attachments[i].text += "\n:file_folder: This channel is now archived.";
                    return reply;
                }
            }
        }
    });

    slackInteractions.action("channel_request_dialog", async (payload, respond) => {
        logger.info("Dialog submission", {
            user_id: payload.user.id,
            type: "dialog_submission",
            callback_id: "channel_request_dialog",
            submission: payload.submission
        });

        let channel_name = payload.submission.channel_name.trim().toLowerCase();
        const me = payload.user.id;
        const { invitee, organization, expire_days, purpose } = payload.submission;
        let topic = `Requested for <@${invitee}>`;
        if (organization) {
            topic += " from " + organization;
        }

        let errors = [];
        if (invitee == me) {
            errors.push({
                name: "invitee",
                error: "You can't request a private channel with just yourself in it!"
            });
        }

        if (!/^[a-z0-9_-]{1,21}$/.test(channel_name)) {
            errors.push({
                name: "channel_name",
                error: "Invalid characters found."
            });
        }

        if (!/^[1-9]\d*$/.test(expire_days)) {
            errors.push({
                name: "expire_days",
                error: "Please enter a valid positive integer."
            });
        }

        if (errors.length > 0) {
            return { errors };
        }

        let res = await slack.bot.users.info({ user: invitee });
        if (res.user.is_bot || res.user.is_app_user) {
            return {
                errors: [{
                    name: "invitee",
                    error: "Invited user must be human."
                }]
            };
        }

        try {
            // TODO move to conversations API after workspace app migration
            res = await slack.user.conversations.create({name: channel_name, is_private: true});
            // res = await slack.user.groups.create({ name: channel_name });
        } catch (err) {
            if (err.data) {
                if ("name_taken" == err.data.error) {
                    return {
                        errors: [{
                            name: "channel_name",
                            error: "This channel name is already taken."
                        }]
                    };
                } else if ("restricted_action" == err.data.error) {
                    return {
                        errors: [{
                            name: "channel_name",
                            error: "You are not allowed to request private " +
                            "channels in this Slack workspace," +
                            "please contact the administrators."
                        }]
                    };
                }
            } else {
                return { errors: [{ error: "Fatal: unknown platform error" }] };
            }
        }

        const channel = res.channel.id;
        channel_name = res.channel.name;

        // Slack API returns UNIX timestamps (seconds since epoch)
        const ts_created = res.channel.created;
        const ts_expiry = ts_created + (ts_day * parseInt(expire_days));
        try {
            await Promise.all([
                slack.user.conversations.invite({ channel, users: `${invitee},${me}` }),
                slack.user.conversations.setTopic({ channel, topic }),
                slack.user.conversations.setPurpose({
                    purpose: purpose || "",
                    channel
                }),
                Channel.insertMany([{
                    _id: channel,
                    name: channel_name,
                    user: invitee,
                    organization: organization || "",
                    purpose: purpose || "",
                    ts_created,
                    ts_expiry,
                    topic
                }])
            ]);
        } catch (err) {
            logger.error(err);
            return { errors: [{ error: "Fatal: unknown platform error" }] };
        }

        respond({
            text: ":white_check_mark: Successfully created private channel " +
            `#${channel_name} for <@${invitee}> from ${organization}!`
        });
    });

    slackInteractions.action("extend_button", async (payload) => {
        logger.info("Button press", {
            user_id: payload.user.id,
            type: "button",
            callback_id: "extend_button",
            action: payload.actions[0]
        });

        if ("extend" != payload.actions[0].name) {
            return;
        }

        try {
            // increment the expiry timestamp of the channel by a week
            await shared.extendChannelExpiry(payload.channel.id, 7);
        } catch (err) {
            logger.error("MongoDB error: failed to save channel", {
                channel: payload.channel.id
            });
            logger.error(err);
            return {
                text: "Failed to extend this channel's expiry date, please " +
                "contact the administrators."
            };
        }

        return {
            text: ":white_check_mark: Successfully extended this channel's " +
            "expiry date by a week."
        };
    });

    slackInteractions.action("request_channel_action", async (payload) => {
        logger.info("Message action", {
            user_id: payload.user.id,
            type: "message_action",
            callback_id: "request_channel_action",
            message: payload.message
        });

        if (!(await shared.isUserAuthorized(payload.user.id))) {
            logger.info("Unauthorized user trying to use channel manager", {
                user: payload.user.id
            });
            return;
        }
        shared.requestChannelDialog(payload.trigger_id, {
            user: payload.message.user
        });
    });
};
